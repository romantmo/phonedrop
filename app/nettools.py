"""Сетевые проверки для сисадмина: DNS и почта домена, SSL-сертификат, порты, IP и WHOIS (RDAP).

Проверки делаются с нашего сервера — то есть «взглядом из интернета», как видит клиент снаружи.

Безопасность (для чайника): такой инструмент нельзя превращать в «дверь внутрь».
- Адреса внутренних сетей (192.168.*, 10.*, 127.0.0.1, сети Docker и т. п.) запрещены: через нас нельзя
  постучаться в сам сервер или в соседние контейнеры. Проверяем ВСЕ адреса, в которые превращается имя,
  и подключаемся именно к проверенному адресу (чтобы имя не «подменили» между проверкой и подключением).
- Портов за раз — не больше 10, проверки ограничены по частоте (это не сканер).
- Пользуются только владелец и добавленные им люди, не гости.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
import socket
import ssl
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit, urlunsplit

import dns.asyncresolver
import dns.exception
import dns.resolver
import dns.reversename
import html as htmllib
import httpx
from cryptography import x509
from cryptography.x509.oid import NameOID

from .i18n import T

HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
DNS_TYPES = ("A", "AAAA", "CNAME", "MX", "NS", "TXT", "CAA", "SOA")
MAX_PORTS = 10


class NetError(Exception):
    """Понятная человеку ошибка проверки."""


# --------------------------------------------------------------- имя или адрес


def clean_host(raw) -> str:
    """Из того, что вставил человек («https://Site.co.il/path», « 8.8.8.8 »), делаем имя или IP."""
    if not isinstance(raw, str):
        raise NetError(T("Введи имя (например, example.com) или IP-адрес"))
    text = raw.strip().lower()
    text = re.sub(r"^[a-z]+://", "", text)          # https://
    text = text.split("/")[0].split("?")[0].split("#")[0]
    text = text.split("@")[-1]                       # user@host
    if text.startswith("[") and "]" in text:         # [IPv6]:порт
        text = text[1:text.index("]")]
    elif text.count(":") == 1:                       # host:порт
        text = text.split(":")[0]
    text = text.rstrip(".")
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        pass
    try:
        text = text.encode("idna").decode("ascii")   # кириллические/ивритские домены → punycode
    except UnicodeError:
        raise NetError(T("Введи имя (например, example.com) или IP-адрес"))
    if not HOST_RE.match(text):
        raise NetError(T("Введи имя (например, example.com) или IP-адрес"))
    return text


def is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


async def public_ips(host: str, allow_private: bool = False) -> list[str]:
    """Все адреса имени. Если хоть один внутренний — отказ (иначе можно обойти защиту)."""
    try:
        ipaddress.ip_address(host)
        ips = [host]
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            infos = await asyncio.wait_for(loop.getaddrinfo(host, None, type=socket.SOCK_STREAM), 6)
        except (socket.gaierror, asyncio.TimeoutError, UnicodeError):
            raise NetError(T("Имя {host} не находится в DNS", host=host))
        ips = list(dict.fromkeys(info[4][0] for info in infos))
    if not ips:
        raise NetError(T("Имя {host} не находится в DNS", host=host))
    # allow_private (только автотесты) разрешает лишь сам компьютер (127.0.0.1) — остальное закрыто всегда
    if not all(is_public(ip) or (allow_private and ipaddress.ip_address(ip).is_loopback) for ip in ips):
        raise NetError(T("Внутренние адреса проверять нельзя — только адреса в интернете"))
    # Сначала IPv4: так поведение привычнее для сисадмина (и у сервера точно есть IPv4).
    return sorted(ips, key=lambda ip: ":" in ip)


# ------------------------------------------------------------------- DNS


async def default_resolve(name: str, rdtype: str) -> list[str]:
    """Записи DNS в виде текста. Нет записей — пустой список."""
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = 5
    try:
        answer = await resolver.resolve(name, rdtype)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        return []
    except dns.exception.Timeout:
        raise NetError(T("DNS не ответил вовремя — попробуй ещё раз"))
    out = []
    for r in answer:
        if rdtype == "TXT":
            out.append(b"".join(r.strings).decode("utf-8", "replace"))
        elif rdtype == "MX":
            out.append(f"{r.preference} {str(r.exchange).rstrip('.')}")
        else:
            out.append(r.to_text().rstrip("."))
    return out


def _check(status: str, text, kind: str | None = None) -> dict:
    return {"status": status, "text": text, **({"kind": kind} if kind else {})}


async def _spf_lookups(record: str, resolve, depth: int = 0, seen: set | None = None) -> int:
    """Сколько DNS-запросов нужно для проверки SPF (по правилам — не больше 10)."""
    seen = seen if seen is not None else set()
    count = 0
    for term in record.split()[1:]:
        t = term.lstrip("+-~?").lower()
        if t.startswith(("include:", "redirect=")):
            count += 1
            target = t.split(":", 1)[1] if t.startswith("include:") else t.split("=", 1)[1]
            if depth < 5 and target not in seen and count < 20:
                seen.add(target)
                for txt in await resolve(target, "TXT"):
                    if txt.lower().startswith("v=spf1"):
                        count += await _spf_lookups(txt, resolve, depth + 1, seen)
                        break
        elif t in ("a", "mx", "ptr") or t.startswith(("a:", "a/", "mx:", "mx/", "ptr:", "exists:")):
            count += 1
    return count


async def dns_report(domain: str, resolve=default_resolve) -> dict:
    domain = clean_host(domain)
    try:
        ipaddress.ip_address(domain)
        raise NetError(T("Здесь нужен домен, а не IP-адрес"))
    except ValueError:
        pass
    types = DNS_TYPES
    results = await asyncio.gather(*(resolve(domain, t) for t in types))
    records = {t: r for t, r in zip(types, results) if r}
    if not records:
        raise NetError(T("Домен {domain} не найден в DNS", domain=domain))
    checks = []

    mx = sorted(records.get("MX", []), key=lambda v: int(v.split()[0]) if v.split()[0].isdigit() else 0)
    mx_hosts = " ".join(v.lower() for v in mx)
    m365 = "mail.protection.outlook.com" in mx_hosts
    google = "google.com" in mx_hosts or "googlemail.com" in mx_hosts
    if not mx:
        checks.append(_check("warn", T("Нет MX — на этот домен нельзя получать почту")))
    elif m365:
        checks.append(_check("info", T("Почта домена — Microsoft 365 (Exchange Online)")))
    elif google:
        checks.append(_check("info", T("Почта домена — Google Workspace")))
    else:
        checks.append(_check("info", T("Почтовый сервер: {mx}", mx=mx[0].split()[-1])))

    # SPF: кто имеет право отправлять почту от имени домена
    spf = [t for t in records.get("TXT", []) if t.lower().startswith("v=spf1")]
    if not spf:
        checks.append(_check("bad", T("Нет SPF — письма от домена чаще попадают в спам")))
    elif len(spf) > 1:
        checks.append(_check("bad", T("Несколько SPF-записей — так нельзя, оставь одну")))
    else:
        rec = spf[0]
        lookups = await _spf_lookups(rec, resolve)
        ending = next((t for t in rec.split() if t.lstrip("+-~?").lower() == "all"), None)
        if ending is None or ending.startswith(("+", "?")) or ending == "all":
            checks.append(_check("warn", T("SPF не запрещает чужие серверы (нет -all или ~all)")))
        elif ending.startswith("-"):
            checks.append(_check("ok", T("SPF есть, строгий (-all)")))
        else:
            checks.append(_check("ok", T("SPF есть, мягкий (~all)")))
        if lookups > 10:
            checks.append(_check("bad", T("В SPF {n} DNS-запросов — больше 10, проверка у получателя сломается", n=lookups)))
        if m365 and "spf.protection.outlook.com" not in rec.lower():
            checks.append(_check("warn", T("В SPF нет include:spf.protection.outlook.com — Microsoft 365 не разрешён")))

    # DMARC: что делать с письмами, которые не прошли SPF/DKIM
    dmarc = [t for t in await resolve(f"_dmarc.{domain}", "TXT") if t.lower().startswith("v=dmarc1")]
    if dmarc:
        records["DMARC"] = dmarc
        tags = dict(p.strip().split("=", 1) for p in dmarc[0].split(";") if "=" in p)
        policy = tags.get("p", "").strip().lower()
        if policy in ("quarantine", "reject"):
            checks.append(_check("ok", T("DMARC есть, политика {p}", p=policy)))
        else:
            checks.append(_check("warn", T("DMARC только наблюдает (p=none) — поддельные письма не блокируются")))
        if "rua" not in {k.strip().lower() for k in tags}:
            checks.append(_check("info", T("В DMARC нет rua — отчёты о поддельных письмах никуда не приходят")))
    else:
        checks.append(_check("warn", T("Нет DMARC — получатели не знают, что делать с поддельными письмами")))

    # DKIM: подпись писем. Проверяем частые селекторы (Microsoft 365, Google, общие).
    selectors = ("selector1", "selector2", "google", "default", "k1", "s1", "dkim")
    found = []
    for sel, cname, txt in zip(selectors,
                               await asyncio.gather(*(resolve(f"{s}._domainkey.{domain}", "CNAME") for s in selectors)),
                               await asyncio.gather(*(resolve(f"{s}._domainkey.{domain}", "TXT") for s in selectors))):
        if cname or any("p=" in t for t in txt):
            found.append(sel)
            records.setdefault("DKIM", []).append(f"{sel}: {(cname or txt)[0][:120]}")
    if found:
        checks.append(_check("ok", T("DKIM найден: {sel}", sel=", ".join(found))))
    elif m365:
        checks.append(_check("warn", T("DKIM для Microsoft 365 не включён (нет selector1/selector2)")))
    else:
        checks.append(_check("info", T("DKIM не найден по обычным селекторам (это не всегда ошибка)")))

    if m365:
        auto = await resolve(f"autodiscover.{domain}", "CNAME")
        records["Autodiscover"] = auto or []
        if any("autodiscover.outlook.com" in a.lower() for a in auto):
            checks.append(_check("ok", T("Autodiscover настроен на Microsoft 365")))
        else:
            checks.append(_check("warn", T("Нет autodiscover → autodiscover.outlook.com — Outlook может не находить почту")))
    return {"domain": domain, "records": records, "checks": checks}


# -------------------------------------------------------------- SSL и сайт


def _verify_text(message: str):
    m = (message or "").lower()
    if "expired" in m:
        return T("Сертификат просрочен")
    if "hostname mismatch" in m or "doesn't match" in m or "not valid for" in m:
        return T("Сертификат выдан на другое имя")
    if "self-signed" in m or "self signed" in m:
        return T("Самоподписанный сертификат — браузеры будут предупреждать")
    if "unable to get local issuer" in m:
        return T("Неполная цепочка: сервер не отдаёт промежуточный сертификат")
    return T("Сертификат не прошёл проверку: {msg}", msg=message or "?")


def _name(name: x509.Name) -> str:
    for oid in (NameOID.COMMON_NAME, NameOID.ORGANIZATION_NAME):
        attrs = name.get_attributes_for_oid(oid)
        if attrs:
            return str(attrs[0].value)
    return name.rfc4514_string()


def _http_head(sock: ssl.SSLSocket, host: str) -> dict:
    sock.settimeout(5)
    sock.sendall(f"HEAD / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: PhoneDrop-check\r\nConnection: close\r\n\r\n".encode())
    data = b""
    try:
        while len(data) < 16384 and b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except (socket.timeout, OSError):
        pass
    lines = data.split(b"\r\n\r\n")[0].decode("latin-1").split("\r\n")
    if not lines or not lines[0].startswith("HTTP/"):
        return {}
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()[:300]
    parts = lines[0].split(" ", 2)
    return {"status": int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0,
            "server": headers.get("server"), "location": headers.get("location"),
            "hsts": headers.get("strict-transport-security")}


def _ssl_probe(host: str, ip: str, port: int) -> dict:
    sni = None if re.match(r"^[0-9.:]+$", host) else host
    verified, problem = True, None
    try:
        ctx = ssl.create_default_context()
        raw = socket.create_connection((ip, port), timeout=6)
        sock = ctx.wrap_socket(raw, server_hostname=host)
    except ssl.SSLCertVerificationError as exc:
        verified, problem = False, _verify_text(exc.verify_message or str(exc))
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            raw = socket.create_connection((ip, port), timeout=6)
            sock = ctx.wrap_socket(raw, server_hostname=sni)
        except (OSError, ssl.SSLError):
            raise NetError(T("Не получилось установить защищённое соединение с {host}:{port}", host=host, port=port))
    except (socket.timeout, TimeoutError):
        raise NetError(T("{host}:{port} не отвечает", host=host, port=port))
    except ConnectionRefusedError:
        raise NetError(T("Порт {port} на {host} закрыт", host=host, port=port))
    except (OSError, ssl.SSLError):
        raise NetError(T("Не получилось установить защищённое соединение с {host}:{port}", host=host, port=port))
    with sock:
        der = sock.getpeercert(binary_form=True)
        tls = sock.version()
        http = _http_head(sock, host) if port in (443, 8443) else {}
    cert = x509.load_der_x509_certificate(der)
    try:
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        names = []
    not_after = cert.not_valid_after_utc
    days = int((not_after - datetime.now(timezone.utc)).total_seconds() // 86400)
    checks = []
    if not verified:
        checks.append(_check("bad", problem))
    elif days < 0:
        checks.append(_check("bad", T("Сертификат просрочен")))
    elif days < 14:
        checks.append(_check("bad", T("Сертификат закончится через {days} дн. — срочно обнови", days=days)))
    elif days < 30:
        checks.append(_check("warn", T("Сертификат закончится через {days} дн.", days=days)))
    else:
        checks.append(_check("ok", T("Сертификат в порядке, ещё {days} дн.", days=days)))
    if tls in ("TLSv1", "TLSv1.1"):
        checks.append(_check("warn", T("Устаревший протокол {tls}", tls=tls)))
    if http and port == 443 and not http.get("hsts"):
        checks.append(_check("info", T("Нет HSTS — браузер не запоминает, что сайт только по HTTPS")))
    return {
        "host": host, "ip": ip, "port": port, "verified": verified, "tls": tls,
        "subject": _name(cert.subject), "issuer": _name(cert.issuer), "names": names[:50],
        "not_before": cert.not_valid_before_utc.isoformat(), "not_after": not_after.isoformat(), "days_left": days,
        "http": http, "checks": checks,
    }


async def ssl_report(raw_host, port, allow_private: bool = False) -> dict:
    host = clean_host(raw_host)
    try:
        port = int(port or 443)
    except (TypeError, ValueError):
        port = 0
    if not 1 <= port <= 65535:
        raise NetError(T("Порт — число от 1 до 65535"))
    ip = (await public_ips(host, allow_private))[0]
    return await asyncio.to_thread(_ssl_probe, host, ip, port)


# ------------------------------------------------------------------ порты


def parse_ports(raw) -> list[int]:
    if isinstance(raw, str):
        raw = re.split(r"[\s,;]+", raw.strip())
    if not isinstance(raw, list):
        raise NetError(T("Порт — число от 1 до 65535"))
    ports = []
    for item in raw:
        if item in ("", None):
            continue
        try:
            p = int(item)
        except (TypeError, ValueError):
            raise NetError(T("Порт — число от 1 до 65535"))
        if not 1 <= p <= 65535:
            raise NetError(T("Порт — число от 1 до 65535"))
        if p not in ports:
            ports.append(p)
    if not ports:
        raise NetError(T("Укажи хотя бы один порт"))
    if len(ports) > MAX_PORTS:
        raise NetError(T("Не больше {n} портов за раз", n=MAX_PORTS))
    return ports


async def _probe_port(ip: str, port: int) -> dict:
    start = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), 3)
        ms = round((time.monotonic() - start) * 1000)
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        return {"port": port, "state": "open", "ms": ms}
    except asyncio.TimeoutError:
        return {"port": port, "state": "filtered"}
    except ConnectionRefusedError:
        return {"port": port, "state": "closed"}
    except OSError:
        return {"port": port, "state": "filtered"}


async def ports_report(raw_host, raw_ports, allow_private: bool = False) -> dict:
    host = clean_host(raw_host)
    ports = parse_ports(raw_ports)
    ip = (await public_ips(host, allow_private))[0]
    results = await asyncio.gather(*(_probe_port(ip, p) for p in ports))
    return {"host": host, "ip": ip, "ports": list(results)}


# ------------------------------------------------------------ IP и WHOIS


def _vcard_name(entity: dict) -> str | None:
    try:
        for item in entity.get("vcardArray", [None, []])[1]:
            if item[0] == "fn" and item[3]:
                return str(item[3])
    except (IndexError, TypeError):
        pass
    return None


def _entity(data: dict, role: str) -> str | None:
    for e in data.get("entities", []) or []:
        if role in (e.get("roles") or []):
            return _vcard_name(e) or e.get("handle")
        inner = _entity(e, role)
        if inner:
            return inner
    return None


async def rdap(query: str, transport=None) -> dict:
    """WHOIS нового образца (RDAP): кто владеет доменом или сетью, когда истекает домен."""
    q = clean_host(query)
    try:
        ipaddress.ip_address(q)
        kind = "ip"
    except ValueError:
        kind = "domain"
    url = f"https://rdap.org/{kind}/{q}"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=10, follow_redirects=True,
                                     headers={"Accept": "application/rdap+json"}) as client:
            r = await client.get(url)
    except httpx.HTTPError:
        raise NetError(T("Служба WHOIS не ответила — попробуй позже"))
    if r.status_code == 404:
        raise NetError(T("Нет данных WHOIS (RDAP) для {q} — у некоторых национальных зон его нет", q=q))
    if r.status_code != 200 or len(r.content) > 2_000_000:
        raise NetError(T("Служба WHOIS не ответила — попробуй позже"))
    try:
        data = r.json()
    except ValueError:
        raise NetError(T("Служба WHOIS не ответила — попробуй позже"))
    events = {e.get("eventAction"): (e.get("eventDate") or "")[:10] for e in data.get("events", []) or []}
    out = {"query": q, "kind": kind}
    if kind == "domain":
        out.update({
            "registrar": _entity(data, "registrar"),
            "registered": events.get("registration"),
            "expires": events.get("expiration"),
            "changed": events.get("last changed"),
            "status": data.get("status", [])[:10],
            "nameservers": [n.get("ldhName", "").lower() for n in data.get("nameservers", []) or []][:10],
        })
        if out["expires"]:
            try:
                days = (datetime.fromisoformat(out["expires"]).replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)).days
                out["days_left"] = days
            except ValueError:
                pass
    else:
        out.update({
            "network": data.get("name"),
            "range": f"{data.get('startAddress', '')} – {data.get('endAddress', '')}".strip(" –"),
            "country": data.get("country"),
            "org": _entity(data, "registrant") or _entity(data, "administrative"),
            "abuse": _entity(data, "abuse"),
        })
    return out


async def reverse_dns(ip: str) -> str | None:
    try:
        resolver = dns.asyncresolver.Resolver()
        resolver.lifetime = 3
        answer = await resolver.resolve(dns.reversename.from_address(ip), "PTR")
        return str(answer[0]).rstrip(".")
    except Exception:
        return None


# ------------------------------------------------------------- QR для Wi-Fi


def wifi_qr_text(ssid, password, security, hidden) -> str:
    """Строка для QR-кода Wi-Fi (её понимают камеры Android и iPhone)."""
    if not isinstance(ssid, str) or not 1 <= len(ssid) <= 64:
        raise NetError(T("Имя сети — от 1 до 64 символов"))
    security = security if security in ("WPA", "WEP", "nopass") else "WPA"
    password = password if isinstance(password, str) else ""
    if security != "nopass" and not 1 <= len(password) <= 128:
        raise NetError(T("Пароль — от 1 до 128 символов"))

    def esc(s: str) -> str:
        return re.sub(r'([\\;,:"])', r"\\\1", s)

    text = f"WIFI:T:{security};S:{esc(ssid)};"
    if security != "nopass":
        text += f"P:{esc(password)};"
    if hidden:
        text += "H:true;"
    return text + ";"


# ------------------------------------------------------- проверка ссылки (v2.4)
# Сервер проходит по ссылке как браузер, но ничего не выполняет: только смотрит, куда она ведёт.
# Каждый переход проверяется на внутренние адреса (как порты и SSL), подключение — к проверенному IP.

SHORTENERS = {
    "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
    "shorturl.at", "tiny.cc", "rb.gy", "s.id", "t.ly", "lnkd.in", "bl.ink", "short.io", "v.gd", "x.gd",
    "qrco.de", "qr.codes", "surl.li", "clck.ru", "did.li", "l.ead.me",
}
# Если имя бренда есть в адресе, а сам домен — чужой, это классический фишинг: microsoft.com.secure-login.xyz
BRANDS = (
    "microsoft", "office365", "outlook", "onedrive", "sharepoint", "live", "apple", "icloud", "google",
    "gmail", "paypal", "amazon", "facebook", "instagram", "whatsapp", "netflix", "dhl", "fedex", "linkedin",
    "docusign", "dropbox", "adobe", "leumi", "hapoalim", "mizrahi", "discountbank", "israelpost", "bit",
)
SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu", "muni", "k12", "idf", "ltd", "plc", "me", "or", "ne"}
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/130.0 Safari/537.36")
MAX_HOPS = 10
PAGE_LIMIT = 256 * 1024


def registrable(host: str) -> str:
    """Основной домен: login.secure.contoso.co.il → contoso.co.il (без полного списка зон — по простому правилу)."""
    try:
        ipaddress.ip_address(host)
        return host                      # для IP-адреса «домена» нет
    except ValueError:
        pass
    parts = host.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in SECOND_LEVEL:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def clean_url(raw) -> str:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4000:
        raise NetError(T("Вставь ссылку, например https://example.com/page"))
    text = raw.strip()
    if not re.match(r"^[a-z][a-z0-9+.-]*://", text, re.I):
        text = "http://" + text
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise NetError(T("Проверяются только ссылки http и https"))
    return text


def url_flags(url: str) -> list[dict]:
    """Признаки опасности, видные по самому адресу — без похода в интернет."""
    flags = []
    parts = urlsplit(url)
    raw_host = (parts.hostname or "").lower()
    try:
        ipaddress.ip_address(raw_host)
        flags.append(_check("warn", T("Вместо имени сайта — голый IP-адрес")))
        return flags
    except ValueError:
        pass
    try:
        host = raw_host.encode("idna").decode("ascii")
    except UnicodeError:
        host = raw_host
    if "xn--" in host:
        try:
            shown = host.encode("ascii").decode("idna")
        except UnicodeError:
            shown = raw_host
        flags.append(_check("warn", T("Адрес с необычными буквами ({shown}) — так подделывают известные сайты", shown=shown)))
    if "@" in parts.netloc:
        flags.append(_check("bad", T("В ссылке есть «@»: браузер откроет не тот сайт, что написан в начале")))
    base = registrable(host)
    labels = host[: -len(base)].split(".") if host.endswith(base) else []
    sub = ".".join(labels)
    for brand in BRANDS:
        if brand == "bit":
            continue
        if re.search(rf"(^|[.-]){brand}([.-]|$)", sub) and brand not in base:
            flags.append(_check("bad", T("В адресе есть «{brand}», но сайт на самом деле — {domain}", brand=brand, domain=base)))
            break
    if host in SHORTENERS or base in SHORTENERS:
        flags.append(_check("info", T("Короткая ссылка: настоящий адрес скрыт"), "short"))
    if parts.scheme.lower() == "http":
        flags.append(_check("info", T("Без шифрования (http) — то, что вводишь на сайте, видно по дороге")))
    return flags


def _title(html: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    if not m:
        return None
    return re.sub(r"\s+", " ", htmllib.unescape(m.group(1))).strip()[:200] or None


def _meta_refresh(html: str) -> str | None:
    m = re.search(r"<meta[^>]+http-equiv=[\"']?refresh[\"']?[^>]*content=[\"'][^\"']*url=([^\"'>]+)", html, re.I)
    return m.group(1).strip() if m else None


async def _fetch_once(url: str, allow_private: bool, verify: bool) -> tuple[int, dict, str, str]:
    parts = urlsplit(url)
    host = clean_host(parts.hostname or "")
    ip = (await public_ips(host, allow_private))[0]
    https = parts.scheme.lower() == "https"
    port = parts.port or (443 if https else 80)
    ip_host = f"[{ip}]" if ":" in ip else ip
    target = urlunsplit((parts.scheme.lower(), f"{ip_host}:{port}", parts.path or "/", parts.query, ""))
    host_header = host if parts.port is None else f"{host}:{parts.port}"
    headers = {"Host": host_header, "User-Agent": BROWSER_UA, "Accept": "text/html,*/*;q=0.8",
               "Accept-Language": "en,he;q=0.8"}
    async with httpx.AsyncClient(verify=verify, timeout=8, follow_redirects=False, trust_env=False) as client:
        request = client.build_request("GET", target, headers=headers,
                                       extensions={"sni_hostname": host} if https else {})
        response = await client.send(request, stream=True)
        try:
            body = b""
            if "html" in response.headers.get("content-type", ""):
                async for chunk in response.aiter_raw():
                    body += chunk
                    if len(body) >= PAGE_LIMIT:
                        break
            # сжатые ответы не распаковываем: нам хватает заголовков и, если повезёт, начала страницы
            text = body.decode("utf-8", "replace") if response.headers.get("content-encoding") in (None, "identity") else ""
            return response.status_code, dict(response.headers), text, ip
        finally:
            await response.aclose()


async def follow_url(url: str, allow_private: bool = False) -> dict:
    """Проходит по переадресациям (до 10), каждую проверяя заново."""
    chain, cert_problem, page = [], None, ""
    current = url
    for hop in range(MAX_HOPS):
        try:
            status, headers, page, ip = await _fetch_once(current, allow_private, True)
        except NetError:
            if not hop:
                raise
            chain.append({"url": current[:500], "status": None, "blocked": True})
            return {"chain": chain, "error": None, "cert_problem": cert_problem, "page": "",
                    "blocked": T("Ссылка перенаправляет во внутреннюю сеть — проверка остановлена")}
        except httpx.ConnectError as exc:
            if "CERTIFICATE_VERIFY_FAILED" not in str(exc) and "certificate" not in str(exc).lower():
                chain.append({"url": current, "status": None})
                return {"chain": chain, "error": T("Сайт не ответил"), "cert_problem": cert_problem, "page": ""}
            cert_problem = cert_problem or T("Сертификат сайта не прошёл проверку — браузер покажет предупреждение")
            try:
                status, headers, page, ip = await _fetch_once(current, allow_private, False)
            except httpx.HTTPError:
                chain.append({"url": current, "status": None})
                return {"chain": chain, "error": T("Сайт не ответил"), "cert_problem": cert_problem, "page": ""}
        except (httpx.HTTPError, ssl.SSLError, OSError):
            chain.append({"url": current, "status": None})
            return {"chain": chain, "error": T("Сайт не ответил"), "cert_problem": cert_problem, "page": ""}
        chain.append({"url": current, "status": status, "ip": ip})
        location = headers.get("location") if 300 <= status < 400 else _meta_refresh(page) if status == 200 else None
        if not location:
            break
        nxt = urljoin(current, location)
        if urlsplit(nxt).scheme.lower() not in ("http", "https"):
            chain.append({"url": nxt[:500], "status": None})
            break
        current = nxt
    return {"chain": chain, "error": None, "cert_problem": cert_problem, "page": page}


# --------------------------------------------------------------- VirusTotal
# Ключ — только в .env на сервере (VT_API_KEY). Бесплатный ключ: 4 запроса в минуту, 500 в сутки,
# только для личного использования. Файлы туда НЕ отправляем — только «отпечаток» (sha256).

VT_API = "https://www.virustotal.com/api/v3"


def _vt_stats(data: dict) -> dict:
    attrs = data.get("data", {}).get("attributes", {})
    stats = attrs.get("last_analysis_stats") or attrs.get("stats") or {}
    return {
        "found": True,
        "malicious": int(stats.get("malicious", 0)),
        "suspicious": int(stats.get("suspicious", 0)),
        "harmless": int(stats.get("harmless", 0)),
        "undetected": int(stats.get("undetected", 0)),
        "date": attrs.get("last_analysis_date"),
    }


async def vt_lookup(kind: str, ident: str, key: str, transport=None) -> dict:
    """kind: urls или files. Ответ: found/malicious/suspicious… или found=False."""
    if kind == "urls":
        ident = base64.urlsafe_b64encode(ident.encode()).decode().rstrip("=")
    try:
        async with httpx.AsyncClient(transport=transport, timeout=15) as client:
            r = await client.get(f"{VT_API}/{kind}/{ident}", headers={"x-apikey": key})
    except httpx.HTTPError:
        return {"error": T("VirusTotal не ответил")}
    if r.status_code == 404:
        return {"found": False}
    if r.status_code == 429:
        return {"error": T("VirusTotal: закончился лимит бесплатного ключа — попробуй позже")}
    if r.status_code in (401, 403):
        return {"error": T("VirusTotal не принял ключ — проверь VT_API_KEY на сервере")}
    if r.status_code != 200:
        return {"error": T("VirusTotal не ответил")}
    try:
        return _vt_stats(r.json())
    except ValueError:
        return {"error": T("VirusTotal не ответил")}


async def vt_submit_url(url: str, key: str, transport=None) -> bool:
    try:
        async with httpx.AsyncClient(transport=transport, timeout=15) as client:
            r = await client.post(f"{VT_API}/urls", headers={"x-apikey": key}, data={"url": url})
    except httpx.HTTPError:
        return False
    return r.status_code == 200


def vt_checks(vt: dict | None, what) -> list[dict]:
    if not vt:
        return []
    if vt.get("error"):
        return [_check("info", vt["error"])]
    if not vt.get("found"):
        return [_check("info", T("VirusTotal ещё не видел {what}", what=what))]
    total = vt["malicious"] + vt["suspicious"] + vt["harmless"] + vt["undetected"]
    if vt["malicious"]:
        return [_check("bad", T("VirusTotal: опасно по мнению {n} из {total} проверок", n=vt["malicious"], total=total))]
    if vt["suspicious"]:
        return [_check("warn", T("VirusTotal: подозрительно по мнению {n} из {total} проверок", n=vt["suspicious"], total=total))]
    return [_check("ok", T("VirusTotal: ничего не найдено ({total} проверок)", total=total))]


async def domain_age_days(domain: str, transport=None) -> tuple[str | None, int | None]:
    try:
        info = await rdap(domain, transport)
    except NetError:
        return None, None
    reg = info.get("registered")
    if not reg:
        return None, None
    try:
        days = (datetime.now(timezone.utc) - datetime.fromisoformat(reg).replace(tzinfo=timezone.utc)).days
    except ValueError:
        return reg, None
    return reg, days


async def url_report(raw, allow_private: bool = False, rdap_transport=None, vt_key: str | None = None,
                     vt_transport=None, vt_allowed=lambda: True) -> dict:
    url = clean_url(raw)
    checks = url_flags(url)
    trip = await follow_url(url, allow_private)
    chain = trip["chain"]
    final = chain[-1]["url"] if chain else url
    final_host = clean_host(urlsplit(final).hostname or "")
    if final != url:
        checks += [c for c in url_flags(final) if c["text"] not in {x["text"] for x in checks}]
    if len(chain) > 4:
        checks.append(_check("warn", T("Много переадресаций ({n}) — так прячут настоящий адрес", n=len(chain) - 1)))
    if trip["cert_problem"]:
        checks.append(_check("bad", trip["cert_problem"]))
    if trip["error"]:
        checks.append(_check("info", trip["error"]))
    if trip.get("blocked"):
        checks.append(_check("bad", trip["blocked"]))
    page = trip["page"] or ""
    password_form = bool(re.search(r"<input[^>]+type=[\"']?password", page, re.I))
    if password_form:
        checks.append(_check("warn", T("Страница просит ввести пароль — убедись, что это настоящий сайт: {domain}",
                                       domain=registrable(final_host))))
    registered, age = None, None
    try:
        ipaddress.ip_address(final_host)
    except ValueError:
        registered, age = await domain_age_days(registrable(final_host), rdap_transport)
    if age is not None and age < 30:
        checks.append(_check("bad", T("Домен зарегистрирован {days} дн. назад — у фишинга почти всегда новые домены", days=age)))
    elif age is not None and age < 180:
        checks.append(_check("warn", T("Домену меньше полугода ({days} дн.)", days=age)))
    vt = None
    if vt_key:
        vt = await vt_lookup("urls", final, vt_key, vt_transport) if vt_allowed() else {
            "error": T("VirusTotal: можно 4 проверки в минуту — попробуй через минуту")}
        checks += vt_checks(vt, T("эту ссылку"))
    if not any(c["status"] in ("bad", "warn") for c in checks):
        checks.insert(0, _check("ok", T("Явных признаков опасности не найдено")))
    return {
        "url": url, "final": final, "domain": registrable(final_host), "chain": chain,
        "registered": registered, "age_days": age, "title": _title(page), "password_form": password_form,
        "checks": sorted(checks, key=lambda c: ("bad", "warn", "info", "ok").index(c["status"])),
        "vt": vt,
    }


# ----------------------------------------------------------------- ClamAV
async def clamd_scan(data: bytes, host: str, port: int, timeout: float = 90) -> dict:
    """Проверка антивирусом ClamAV (контейнер clamav). Ответ: clean / found (+имя) / error / unavailable."""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), 5)
    except (OSError, asyncio.TimeoutError):
        return {"status": "unavailable"}
    try:
        writer.write(b"zINSTREAM\0")
        view = memoryview(data)
        for i in range(0, len(data), 65536):
            chunk = view[i:i + 65536]
            writer.write(len(chunk).to_bytes(4, "big") + bytes(chunk))
            await writer.drain()
        writer.write(b"\0\0\0\0")
        await writer.drain()
        reply = (await asyncio.wait_for(reader.read(4096), timeout)).decode("utf-8", "replace").strip("\0\n ")
    except (OSError, asyncio.TimeoutError):
        return {"status": "unavailable"}
    finally:
        writer.close()
    if reply.endswith("FOUND"):
        name = reply.split(":", 1)[-1].rsplit("FOUND", 1)[0].strip()
        return {"status": "found", "name": name[:200]}
    if reply.endswith(": OK") or reply == "stream: OK":
        return {"status": "clean"}
    if "size limit" in reply.lower():
        return {"status": "error", "text": T("Слишком большой файл для антивируса")}
    return {"status": "error", "text": T("Антивирус не смог проверить файл")}
