"""v2.3: инструменты сисадмина. Сеть в тестах не нужна: DNS и WHOIS подменены, SSL и порты — на своём сервере."""

import asyncio
import base64
import datetime
import os
import socket
import ssl
import threading

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient

from app import nettools
from app.main import Settings, create_app
from test_app import BASE, Device, Pusher, join, new_room, pair, store

ZONE = {
    ("contoso.co.il", "A"): ["20.1.2.3"],
    ("contoso.co.il", "MX"): ["0 contoso-co-il.mail.protection.outlook.com"],
    ("contoso.co.il", "NS"): ["ns1.example.net"],
    ("contoso.co.il", "TXT"): ["v=spf1 include:spf.protection.outlook.com -all", "MS=ms123"],
    ("_dmarc.contoso.co.il", "TXT"): ["v=DMARC1; p=none"],
    ("selector1._domainkey.contoso.co.il", "CNAME"): ["selector1-contoso-co-il._domainkey.contoso.onmicrosoft.com"],
    ("autodiscover.contoso.co.il", "CNAME"): ["autodiscover.outlook.com"],
    ("spf.protection.outlook.com", "TXT"): ["v=spf1 ip4:40.92.0.0/15 -all"],
    # плохой домен: две SPF, нет DMARC, слишком много include
    ("bad.example", "A"): ["93.184.215.14"],
    ("bad.example", "MX"): ["10 mx.bad.example"],
    ("bad.example", "TXT"): ["v=spf1 " + " ".join(f"include:s{i}.example" for i in range(11)) + " ~all",
                             "v=spf1 -all"],
}


async def fake_resolve(name, rdtype):
    return ZONE.get((name, rdtype), [])


@pytest.fixture
def net_settings(tmp_path):
    return Settings(data_dir=tmp_path, public_url=BASE, min_free_disk_mb=0, devices_per_ip=1000,
                    sends_per_min=1000, cleanup_interval_sec=3600, net_allow_private=True)


def rdap_handler(request: httpx.Request):
    path = request.url.path
    if path == "/domain/contoso.co.il":
        return httpx.Response(200, json={
            "status": ["active"],
            "events": [{"eventAction": "registration", "eventDate": "2015-03-01T00:00:00Z"},
                       {"eventAction": "expiration", "eventDate": "2099-03-01T00:00:00Z"}],
            "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "Domain The Net"]]]}],
            "nameservers": [{"ldhName": "NS1.EXAMPLE.NET"}],
        })
    if path.startswith("/ip/"):
        return httpx.Response(200, json={
            "name": "HETZNER-CLOUD", "startAddress": "2.31.0.0", "endAddress": "2.31.255.255", "country": "DE",
            "entities": [{"roles": ["abuse"], "vcardArray": ["vcard", [["fn", {}, "text", "Abuse Team"]]]}],
        })
    return httpx.Response(404)


@pytest.fixture
def net_client(net_settings):
    with TestClient(create_app(net_settings), base_url=BASE) as c:
        c.pusher = Pusher()
        st = c.app.state.store
        st.push_sender = c.pusher
        st.net_resolve = fake_resolve
        st.net_transport = httpx.MockTransport(rdap_handler)
        yield c


@pytest.fixture
def admin(net_client):
    pc, phone = Device(net_client, "pc"), Device(net_client, "phone")
    pair(pc, phone)
    return phone


# ------------------------------------------------------------- разбор ввода


@pytest.mark.parametrize("raw, host", [
    ("https://Contoso.co.il/owa?x=1", "contoso.co.il"),
    (" mail.contoso.co.il:443 ", "mail.contoso.co.il"),
    ("8.8.8.8", "8.8.8.8"),
    ("[2606:4700::1111]:443", "2606:4700::1111"),
    ("user@contoso.co.il", "contoso.co.il"),
    ("пример.рф", "xn--e1afmkfd.xn--p1ai"),
])
def test_clean_host(raw, host):
    assert nettools.clean_host(raw) == host


@pytest.mark.parametrize("raw", ["", "a b.com", "-x.com", None, "x" * 300 + ".com"])
def test_clean_host_rejects(raw):
    with pytest.raises(nettools.NetError):
        nettools.clean_host(raw)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.18.0.2", "169.254.169.254",
                                "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1", "0.0.0.0"])
def test_internal_addresses_blocked(ip):
    with pytest.raises(nettools.NetError):
        asyncio.run(nettools.public_ips(ip))


def test_public_address_allowed():
    assert asyncio.run(nettools.public_ips("8.8.8.8")) == ["8.8.8.8"]


def test_ports_parsed_and_limited():
    assert nettools.parse_ports("443, 3389 25;443") == [443, 3389, 25]
    for bad in ("", "0", "70000", "abc", ",".join(str(p) for p in range(1, 13))):
        with pytest.raises(nettools.NetError):
            nettools.parse_ports(bad)


def test_wifi_qr_escapes_special_chars():
    assert nettools.wifi_qr_text('Office;5G', 'p@ss:"1"', "WPA", True) == 'WIFI:T:WPA;S:Office\\;5G;P:p@ss\\:\\"1\\";H:true;;'
    assert nettools.wifi_qr_text("Guest", "", "nopass", False) == "WIFI:T:nopass;S:Guest;;"
    with pytest.raises(nettools.NetError):
        nettools.wifi_qr_text("Office", "", "WPA", False)


# ------------------------------------------------------------------- DNS


def statuses(report):
    return {c["text"]: c["status"] for c in report["checks"]}


def test_dns_report_microsoft365(admin):
    r = admin.post("/api/net/dns", json={"host": "https://contoso.co.il/"})
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["records"]["MX"] == ["0 contoso-co-il.mail.protection.outlook.com"]
    st = statuses(rep)
    assert st["Почта домена — Microsoft 365 (Exchange Online)"] == "info"
    assert st["SPF есть, строгий (-all)"] == "ok"
    assert st["DMARC только наблюдает (p=none) — поддельные письма не блокируются"] == "warn"
    assert st["DKIM найден: selector1"] == "ok"
    assert st["Autodiscover настроен на Microsoft 365"] == "ok"


def test_dns_report_finds_problems(admin):
    rep = admin.post("/api/net/dns", json={"host": "bad.example"}).json()
    st = statuses(rep)
    assert st["Несколько SPF-записей — так нельзя, оставь одну"] == "bad"
    assert st["Нет DMARC — получатели не знают, что делать с поддельными письмами"] == "warn"


def test_spf_lookup_limit_counted():
    rec = ZONE[("bad.example", "TXT")][0]
    assert asyncio.run(nettools._spf_lookups(rec, fake_resolve)) == 11


def test_dns_unknown_domain_and_translation(admin):
    r = admin.post("/api/net/dns", json={"host": "nothing.example"})
    assert r.status_code == 400 and "nothing.example" in r.json()["detail"]
    r = admin.post("/api/net/dns", json={"host": "nothing.example"}, headers={"Accept-Language": "en"})
    assert r.json()["detail"] == "Domain nothing.example was not found in DNS"


# --------------------------------------------------------------- SSL, порты


def make_cert(tmp_path, name="localhost", days=10):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=days))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "c.pem", tmp_path / "k.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return cert_path, key_path


@pytest.fixture
def tls_server(tmp_path):
    cert, key = make_cert(tmp_path)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(5)
    stop = threading.Event()

    def serve():
        srv.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
            except (socket.timeout, OSError):
                continue
            try:
                with ctx.wrap_socket(conn, server_side=True) as s:
                    s.settimeout(1)
                    try:
                        s.recv(1024)
                        s.sendall(b"HTTP/1.1 200 OK\r\nServer: test\r\n\r\n")
                    except OSError:
                        pass
            except (ssl.SSLError, OSError):
                pass

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    yield srv.getsockname()[1]
    stop.set()
    srv.close()


def test_ssl_self_signed_reported(admin, tls_server):
    r = admin.post("/api/net/ssl", json={"host": "localhost", "port": tls_server})
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["verified"] is False and rep["subject"] == "localhost" and rep["names"] == ["localhost"]
    assert 8 <= rep["days_left"] <= 10
    assert rep["checks"][0] == {"status": "bad", "text": "Самоподписанный сертификат — браузеры будут предупреждать"}


def test_ports_open_and_closed(admin, tls_server):
    free = socket.socket()
    free.bind(("127.0.0.1", 0))
    closed = free.getsockname()[1]
    free.close()
    r = admin.post("/api/net/ports", json={"host": "127.0.0.1", "ports": f"{tls_server}, {closed}"})
    assert r.status_code == 200, r.text
    states = {p["port"]: p["state"] for p in r.json()["ports"]}
    assert states == {tls_server: "open", closed: "closed"}


def test_internal_targets_blocked_on_real_server(client, pc, phone):
    """Обычные настройки (как на сервере): к 127.0.0.1 и внутренней сети Docker не подключиться."""
    pair(pc, phone)
    for host in ("127.0.0.1", "localhost", "http://169.254.169.254/latest", "172.17.0.1"):
        r = phone.post("/api/net/ports", json={"host": host, "ports": "22"})
        assert r.status_code == 400, (host, r.text)
        assert phone.post("/api/net/ssl", json={"host": host}).status_code == 400


# ----------------------------------------------------------- IP и WHOIS


def test_whois_domain_and_ip(admin):
    rep = admin.post("/api/net/whois", json={"query": "contoso.co.il"}).json()
    assert rep["registrar"] == "Domain The Net" and rep["expires"] == "2099-03-01"
    assert rep["nameservers"] == ["ns1.example.net"] and rep["days_left"] > 1000
    rep = admin.post("/api/net/whois", json={"query": "2.31.111.188"}).json()
    assert (rep["network"], rep["country"], rep["abuse"]) == ("HETZNER-CLOUD", "DE", "Abuse Team")
    r = admin.post("/api/net/whois", json={"query": "nothing.example"})
    assert r.status_code == 400


def test_my_ip(admin):
    r = admin.get("/api/net/me")
    assert r.status_code == 200 and r.json()["ip"] == "testclient"


def test_wifi_qr_endpoint(admin):
    r = admin.post("/api/net/wifi-qr", json={"ssid": "Office", "password": "12345678", "security": "WPA"})
    assert r.status_code == 200 and r.json()["svg"].startswith("<?xml") or "<svg" in r.json()["svg"]


# --------------------------------------------------------------- доступ


def test_guests_and_strangers_cannot_use(net_client, admin):
    stranger = Device(net_client, "phone")
    assert stranger.post("/api/net/dns", json={"host": "contoso.co.il"}).status_code == 401
    rid, code = new_room(admin, title="Клиент", owner_name="Роман")
    guest = join(net_client, code)
    assert guest.post("/api/net/dns", json={"host": "contoso.co.il"}).status_code == 403
    assert guest.post("/api/secrets", json={}).status_code == 403
    # запрос с чужого сайта
    r = admin.post("/api/net/dns", json={"host": "contoso.co.il"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_rate_limited(admin):
    codes = [admin.post("/api/net/dns", json={"host": "contoso.co.il"}).status_code for _ in range(32)]
    assert codes.count(429) >= 1


# ------------------------------------------------------- одноразовая ссылка


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def new_secret(admin, **kw):
    body = {"iv": b64(os.urandom(12)), "ct": b64(os.urandom(40)), "ttl": 3600, "label": "VPN Иры"}
    body.update(kw)
    return admin.post("/api/secrets", json=body)


def test_secret_opens_once_and_notifies(net_client, admin):
    admin.post("/api/push/subscribe", json={"endpoint": "https://push.example/1", "keys": {"p256dh": "k", "auth": "a"}})
    r = new_secret(admin)
    assert r.status_code == 200, r.text
    sid, url = r.json()["id"], r.json()["url"]
    assert url == f"{BASE}/k/{sid}"
    row = store(net_client).one("SELECT * FROM secrets WHERE id=?", sid)
    assert row["ct"] and row["opened"] is None
    # открыть может любой человек со ссылкой — без аккаунта и без cookie
    anyone = Device(net_client, "room")
    page = anyone.get(f"/k/{sid}")
    assert page.status_code == 200 and "secret.js" in page.text and page.headers["cache-control"] == "no-store"
    assert anyone.get(f"/api/secrets/{sid}/status").json()["ok"] is True
    opened = anyone.post(f"/api/secrets/{sid}/open")
    assert opened.status_code == 200 and set(opened.json()) == {"iv", "ct"}
    # второй раз — уже нет, и шифровка стёрта с сервера
    assert anyone.post(f"/api/secrets/{sid}/open").status_code == 404
    assert anyone.get(f"/api/secrets/{sid}/status").status_code == 404
    row = store(net_client).one("SELECT * FROM secrets WHERE id=?", sid)
    assert row["ct"] is None and row["iv"] is None and row["opened"]
    items = admin.get("/api/secrets").json()["items"]
    assert items[0]["id"] == sid and items[0]["opened"] and items[0]["label"] == "VPN Иры"


def test_secret_push_sent(net_client, admin):
    admin.post("/api/push/subscribe", json={"endpoint": "https://push.example/1", "keys": {"p256dh": "k", "auth": "a"}})
    sid = new_secret(admin).json()["id"]
    Device(net_client, "room").post(f"/api/secrets/{sid}/open")
    import time
    for _ in range(50):
        if net_client.pusher.sent:
            break
        time.sleep(0.02)
    assert "Одноразовую ссылку открыли" in net_client.pusher.sent[-1][1]
    assert "VPN Иры" in net_client.pusher.sent[-1][1]


def test_secret_validation_and_delete(net_client, admin):
    assert new_secret(admin, ttl=999).status_code == 400
    assert new_secret(admin, iv="short").status_code == 400
    assert new_secret(admin, ct="<script>").status_code == 400
    assert new_secret(admin, ct="A" * 50_000).status_code == 400
    sid = new_secret(admin).json()["id"]
    other_pc, other = Device(net_client, "pc"), Device(net_client, "phone")
    pair(other_pc, other)
    other.delete(f"/api/secrets/{sid}")          # чужую ссылку удалить нельзя
    assert Device(net_client, "room").get(f"/api/secrets/{sid}/status").status_code == 200
    admin.delete(f"/api/secrets/{sid}")
    assert Device(net_client, "room").get(f"/api/secrets/{sid}/status").status_code == 404
    assert other.get("/api/secrets").json()["items"] == []


def test_secret_open_from_other_site_rejected(net_client, admin):
    sid = new_secret(admin).json()["id"]
    r = Device(net_client, "room").post(f"/api/secrets/{sid}/open", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_secret_expires(net_client, admin):
    sid = new_secret(admin).json()["id"]
    st = store(net_client)
    st.run("UPDATE secrets SET expires=1 WHERE id=?", sid)
    assert Device(net_client, "room").post(f"/api/secrets/{sid}/open").status_code == 404
    asyncio.run(st.cleanup())
    assert st.one("SELECT 1 FROM secrets WHERE id=?", sid) is None
