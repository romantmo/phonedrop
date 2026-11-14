"""v2.5: исправления по аудиту безопасности."""

import asyncio
import base64
import ipaddress

import pytest
from fastapi.testclient import TestClient

import app.main as appmain
import converter.main as convmain
from app import nettools
from app.main import Settings, create_app
from test_app import BASE, jpeg, pair


# ---------------------------------------------------------------- №1 вход


def test_require_login_refuses_to_start_without_google(tmp_path):
    with pytest.raises(RuntimeError):
        create_app(Settings(data_dir=tmp_path, public_url=BASE, require_login=True))
    with pytest.raises(RuntimeError):   # ключи есть, а список админов пуст — тоже нельзя
        create_app(Settings(data_dir=tmp_path, public_url=BASE, require_login=True,
                            google_client_id="id", google_client_secret="s"))
    s = Settings(data_dir=tmp_path, public_url=BASE, require_login=True, google_client_id="id",
                 google_client_secret="s", allowed_emails={"admin@example.com"})
    create_app(s)
    assert s.login_required


def test_login_required_without_google_when_flag_set(tmp_path):
    s = Settings(data_dir=tmp_path, public_url=BASE, require_login=True)
    assert s.login_required and not s.google_enabled


# ---------------------------------------------------------- №8 push-адреса


@pytest.mark.parametrize("endpoint, code", [
    ("https://fcm.googleapis.com/fcm/send/abc", 200),
    ("https://evil.example/hook", 400),
    ("https://fcm.googleapis.com.evil.example/x", 400),
    ("https://169.254.169.254/latest", 400),
])
def test_push_only_to_real_push_services(pc, phone, endpoint, code):
    pair(pc, phone)
    r = phone.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": "k", "auth": "a"}})
    assert r.status_code == code


def test_push_hosts_default_list(tmp_path, monkeypatch):
    monkeypatch.delenv("PUSH_HOSTS", raising=False)
    hosts = Settings(data_dir=tmp_path).push_hosts
    assert "fcm.googleapis.com" in hosts and "push.apple.com" in hosts and "push.example" not in hosts


# ------------------------------------------------------- №11 свои адреса


@pytest.mark.parametrize("ip, public", [
    ("64:ff9b::7f00:1", False),      # 127.0.0.1 внутри NAT64
    ("::7f00:1", False),             # 127.0.0.1 в старом формате
    ("64:ff9b::808:808", True),      # 8.8.8.8 внутри NAT64 — обычный адрес в интернете
    ("64:ff9b:1::1", False),
    ("8.8.8.8", True),
])
def test_embedded_ipv4_checked(ip, public):
    assert nettools.is_public(ip) is public


def test_own_server_address_blocked():
    saved = list(nettools.BLOCKED_NETS)
    try:
        nettools.BLOCKED_NETS[:] = asyncio.run(nettools.own_networks("", ("8.8.8.8", "2001:4860::/32")))
        assert not nettools.is_public("8.8.8.8")
        assert not nettools.is_public("2001:4860:4860::8888")
        assert nettools.is_public("1.1.1.1")
        with pytest.raises(nettools.NetError):
            asyncio.run(nettools.public_ips("8.8.8.8"))
    finally:
        nettools.BLOCKED_NETS[:] = saved
    assert ipaddress.ip_network("8.8.8.8/32") not in nettools.BLOCKED_NETS


def test_dns_report_refuses_internal_names():
    with pytest.raises(nettools.NetError):
        asyncio.run(nettools.dns_report("clamav", lambda *a: None))


# ---------------------------------------------------- №10 VirusTotal без токенов


def test_strip_url():
    assert nettools.strip_url("https://user:pw@site.example/reset?token=SECRET#x") == "https://site.example/reset"
    assert nettools.strip_url("http://a.example") == "http://a.example/"


def test_virustotal_gets_url_without_query(net_client, admin, site):
    admin.post("/api/net/url", json={"url": f"{site}/login?token=SECRET123"})
    path = net_client.vt[-1][1]
    sent = base64.urlsafe_b64decode(path.rsplit("/", 1)[1] + "==").decode()
    assert sent == f"{site}/login" and "SECRET" not in sent


# ---------------------------------------------------------- №6 конвертер


def test_converter_operation_is_killed_after_timeout(monkeypatch):
    monkeypatch.setattr(convmain, "CONVERT_TIMEOUT_SEC", 0.001)
    with TestClient(convmain.app) as c:
        r = c.post("/convert/images-jpg", files={"files": ("a.jpg", jpeg(), "image/jpeg")})
    assert r.status_code == 422 and "не успели" in r.json()["detail"]


def test_converter_errors_from_child_process():
    with TestClient(convmain.app) as c:
        assert c.post("/convert/nope", files={"files": ("a.jpg", jpeg(), "image/jpeg")}).status_code == 404
        r = c.post("/convert/images-jpg", files={"files": ("a.jpg", b"not an image", "image/jpeg")})
        assert r.status_code == 422


def test_converted_result_size_limited(pc, phone, monkeypatch):
    pair(pc, phone)
    monkeypatch.setattr(appmain, "CONVERTED_MAX", 100)
    r = phone.post("/api/tools/images-jpg", files={"files": ("a.jpg", jpeg(), "image/jpeg")})
    assert r.status_code == 502


# ---------------------------------------------------------- №9 размер письма


def test_mail_upload_limited_before_parsing(admin):
    big = b"x" * (3 * 1024 * 1024)   # лимит в тестах 1 МБ (+1 на форму)
    r = admin.post("/api/net/mail", files={"file": ("m.eml", big, "message/rfc822")})
    assert r.status_code == 413
