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
import ipaddress
import re
import socket
import ssl
import time
from datetime import datetime, timezone

import dns.asyncresolver
import dns.exception
import dns.resolver
import dns.reversename
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
    if not allow_private and not all(is_public(ip) for ip in ips):
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


def _check(status: str, text) -> dict:
    return {"status": status, "text": text}


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
