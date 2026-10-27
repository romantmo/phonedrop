"""Автотесты PhoneDrop. В CI они запускаются на каждый push: `pytest -q`.

Большая часть тестов проверяет безопасность и сохранность данных:
чужой не прочитает чат, не подключится по старому QR-коду, «чужой» компьютер
не оставит следов, а «свой» переживёт перезапуск сервера (деплой).
"""

import time

import pytest
from fastapi.testclient import TestClient

from app.main import MAX_DEVICES, STATIC_DIR, Settings, create_app

BASE = "https://testserver"
WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class Device:
    """Одно устройство (компьютер или телефон) со своими cookie."""

    def __init__(self, client: TestClient, role: str):
        self.client = client
        self.role = role
        self.cookies: dict[str, str] = {}
        self.raw_cookies: dict[str, str] = {}

    def headers(self, extra=None) -> dict:
        h = {"X-PD-Role": self.role, "Origin": BASE, "User-Agent": WIN_UA}
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        h.update(extra or {})
        return {k: v for k, v in h.items() if v is not None}

    def request(self, method, url, headers=None, **kw):
        self.client.cookies.clear()
        r = self.client.request(method, url, headers=self.headers(headers), follow_redirects=False, **kw)
        for raw in r.headers.get_list("set-cookie"):
            name, value = raw.split(";", 1)[0].split("=", 1)
            self.raw_cookies[name] = raw
            if "Max-Age=0" in raw or not value.strip('"'):
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = value
        self.client.cookies.clear()
        return r

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)

    def ws(self, extra=None):
        return self.client.websocket_connect(f"/ws?role={self.role}", headers=self.headers(extra))


@pytest.fixture
def settings(tmp_path):
    return Settings(
        data_dir=tmp_path,
        public_url=BASE,
        max_upload_mb=1,
        chat_quota_mb=2,
        min_free_disk_mb=0,
        devices_per_ip=1000,
        sends_per_min=1000,
        cleanup_interval_sec=3600,  # уборку в тестах запускаем вручную
    )


class Pusher:
    """Подмена отправки push: вместо интернета записываем, что ушло бы."""

    def __init__(self):
        self.sent = []
        self.gone = set()

    def __call__(self, info, data):
        from app.main import PushGone

        if info["endpoint"] in self.gone:
            raise PushGone()
        self.sent.append((info["endpoint"], data))


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings), base_url=BASE) as c:
        c.pusher = Pusher()
        c.app.state.store.push_sender = c.pusher
        yield c


@pytest.fixture
def pc(client):
    return Device(client, "pc")


@pytest.fixture
def phone(client):
    return Device(client, "phone")


def store(client):
    return client.app.state.store


def open_pc(pc: Device) -> dict:
    r = pc.post("/api/pc/session")
    assert r.status_code == 200, r.text
    return r.json()


def code_of(state: dict) -> str:
    return state["pair"]["url"].rsplit("/", 1)[1]


def pair(pc: Device, phone: Device) -> str:
    """Компьютер показывает QR, телефон сканирует. Возвращает id чата."""
    r = phone.post(f"/api/pair/{code_of(open_pc(pc))}")
    assert r.status_code == 200, r.text
    return r.json()["chat_id"]


def send_text(dev: Device, text: str, chat_id: str | None = None):
    data = {"text": text}
    if chat_id:
        data["chat_id"] = chat_id
    return dev.post("/api/send", data=data)


# ------------------------------------------------------------ базовая работа


def test_healthz_shows_version(client, monkeypatch):
    monkeypatch.setenv("APP_VERSION", "1.2.3")
    assert client.get("/healthz").json() == {"status": "ok", "version": "1.2.3"}


def test_pages_load(client):
    for path in ("/", "/chat", "/pair/whatever", "/sw.js", "/static/chat.js", "/static/icons/badge-96.png",
                 "/static/icons/icon.svg", "/static/icons/favicon-64.png"):
        assert client.get(path).status_code == 200, path
    assert client.get("/manifest.webmanifest").json()["share_target"]["action"] == "/share"


def test_new_pc_shows_qr_and_defaults_to_temp(pc):
    state = open_pc(pc)
    assert state["linked"] is False
    assert state["device"] == {"label": "Windows · Chrome", "mode": "temp"}
    assert state["pair"]["url"].startswith(f"{BASE}/pair/")
    assert state["pair"]["qr_svg"].startswith("<svg")
    assert "Max-Age" not in pc.raw_cookies["pd_pc"]  # «чужой»: cookie до закрытия браузера


def test_refresh_keeps_same_pc_and_rotates_code(pc, phone):
    first = open_pc(pc)
    second = open_pc(pc)
    assert first["chat_id"] == second["chat_id"]
    assert phone.post(f"/api/pair/{code_of(first)}").status_code == 410  # старый код больше не работает
    assert phone.post(f"/api/pair/{code_of(second)}").status_code == 200


def test_pairing_creates_chat_on_phone(pc, phone):
    chat_id = pair(pc, phone)
    assert "pd_phone" in phone.cookies
    assert "Max-Age=31536000" in phone.raw_cookies["pd_phone"]
    chats = phone.get("/api/phone/chats").json()["chats"]
    assert [(c["id"], c["label"], c["mode"]) for c in chats] == [(chat_id, "Windows · Chrome", "temp")]
    assert open_pc(pc)["linked"] is True


def test_text_both_directions(pc, phone):
    chat_id = pair(pc, phone)
    assert send_text(phone, "  пароль: 123\r\nвторая строка ", chat_id).status_code == 200
    assert send_text(pc, "ответ с компьютера").status_code == 200
    messages = pc.get("/api/state").json()["messages"]
    assert [(m["sender"], m["text"]) for m in messages] == [
        ("phone", "пароль: 123\nвторая строка"),
        ("pc", "ответ с компьютера"),
    ]
    assert phone.get(f"/api/chats/{chat_id}").json()["messages"] == messages


def test_phone_with_two_computers_has_two_chats(client, pc, phone):
    home = pair(pc, phone)
    work_pc = Device(client, "pc")
    work = pair(work_pc, phone)
    send_text(phone, "на домашний", home)
    send_text(phone, "на рабочий", work)
    assert [m["text"] for m in pc.get("/api/state").json()["messages"]] == ["на домашний"]
    assert [m["text"] for m in work_pc.get("/api/state").json()["messages"]] == ["на рабочий"]
    assert len(phone.get("/api/phone/chats").json()["chats"]) == 2


def test_file_upload_and_download(pc, phone):
    chat_id = pair(pc, phone)
    content = b"%PDF-1.4 test"
    r = phone.post("/api/send", data={"chat_id": chat_id},
                   files={"files": ("отчёт.pdf", content, "application/pdf")})
    m = r.json()["messages"][0]
    assert (m["kind"], m["name"], m["size"]) == ("file", "отчёт.pdf", len(content))
    inline = pc.get(m["url"])
    assert inline.content == content
    assert inline.headers["content-disposition"].startswith("inline")
    assert pc.get(m["download_url"]).headers["content-disposition"].startswith("attachment")
    assert phone.get(m["url"]).content == content


def test_voice_message(pc, phone):
    pair(pc, phone)
    r = pc.post("/api/send", files={"voice": ("voice.webm", b"OggS-fake", "audio/webm;codecs=opus")},
                data={"duration": "12.34"})
    m = r.json()["messages"][0]
    assert (m["kind"], m["mime"], m["duration"]) == ("voice", "audio/webm", 12.3)
    assert pc.post("/api/send", files={"voice": ("x.html", b"<b>", "text/html")}).status_code == 400


def test_delete_message_by_other_side(pc, phone):
    chat_id = pair(pc, phone)
    m = phone.post("/api/send", data={"chat_id": chat_id},
                   files={"files": ("a.txt", b"abc", "text/plain")}).json()["messages"][0]
    assert pc.delete(f"/api/messages/{m['id']}").status_code == 200
    assert pc.get(m["url"]).status_code == 404
    assert phone.get(f"/api/chats/{chat_id}").json()["messages"] == []


def test_unread_counter(pc, phone):
    chat_id = pair(pc, phone)
    send_text(pc, "раз")
    send_text(pc, "два")
    assert phone.get("/api/phone/chats").json()["chats"][0]["unread"] == 2
    phone.post(f"/api/chats/{chat_id}/read")
    assert phone.get("/api/phone/chats").json()["chats"][0]["unread"] == 0


def test_rename_computer(pc, phone):
    chat_id = pair(pc, phone)
    r = phone.post(f"/api/chats/{chat_id}/rename", json={"name": "  Рабочий ноутбук\n "})
    assert r.json()["label"] == "Рабочий ноутбук"
    assert pc.get("/api/state").json()["device"]["label"] == "Рабочий ноутбук"


def test_rename_from_computer_before_and_after_pairing(pc, phone):
    open_pc(pc)
    assert pc.post("/api/pc/rename", json={"name": "Рабочий ноутбук"}).json()["label"] == "Рабочий ноутбук"
    chat_id = pair(pc, phone)  # имя, заданное до сканирования, сразу видно на телефоне
    assert phone.get("/api/phone/chats").json()["chats"][0]["label"] == "Рабочий ноутбук"
    with phone.ws() as ws_phone:
        ws_phone.receive_json()  # presence
        pc.post("/api/pc/rename", json={"name": "Домашний ПК"})
        event = ws_phone.receive_json()
        assert event == {"type": "renamed", "chat_id": chat_id, "label": "Домашний ПК"}
    assert pc.post("/api/pc/rename", json={"name": "   "}).status_code == 400
    assert phone.post("/api/pc/rename", json={"name": "x"}).status_code == 403


def test_websocket_live_updates(client, pc, phone):
    open_pc(pc)
    with pc.ws() as ws_pc:
        code = code_of(open_pc(pc))
        phone.post(f"/api/pair/{code}")
        assert ws_pc.receive_json() == {"type": "linked"}
        chat_id = phone.get("/api/phone/chats").json()["chats"][0]["id"]
        with phone.ws() as ws_phone:
            event = ws_pc.receive_json()
            assert event["type"] == "presence" and event["phone_online"] is True
            assert ws_phone.receive_json()["pc_online"] is True
            send_text(phone, "привет", chat_id)
            msg = ws_pc.receive_json()
            assert msg["type"] == "message" and msg["chat_id"] == chat_id and msg["message"]["text"] == "привет"


def test_share_goes_to_online_computer(client, pc, phone):
    home = pair(pc, phone)
    work_pc = Device(client, "pc")
    work = pair(work_pc, phone)
    with work_pc.ws() as ws:  # сейчас сижу за рабочим компьютером
        ws.receive_json()
        r = phone.post(
            "/share",
            headers={"X-PD-Role": None, "Origin": None},  # так присылает сам Android
            data={"title": "Статья", "url": "https://example.com/a"},
            files={"files": ("photo.jpg", b"\xff\xd8\xff", "image/jpeg")},
        )
    assert r.status_code == 303
    assert r.headers["location"] == f"/chat?c={work}&shared=2"
    messages = work_pc.get("/api/state").json()["messages"]
    assert messages[0]["text"] == "Статья\nhttps://example.com/a"
    assert messages[1]["name"] == "photo.jpg"
    assert pc.get("/api/state").json()["messages"] == [] and home


def test_share_without_pairing_redirects(phone):
    r = phone.post("/share", headers={"X-PD-Role": None}, data={"text": "x"})
    assert r.headers["location"] == "/chat?share=nosession"


# ------------------------------------------------------- режимы и хранение


def test_temp_pc_deleted_after_tab_closed(client, pc, phone, settings, tmp_path):
    chat_id = pair(pc, phone)
    pc.post("/api/send", files={"files": ("a.txt", b"abc", "text/plain")})
    assert (tmp_path / "files" / chat_id).exists()
    settings.pc_grace_sec = 0
    with phone.ws() as ws_phone:
        with pc.ws() as ws_pc:
            ws_pc.receive_json()
        time.sleep(0.01)
        client.portal.call(store(client).cleanup)  # вкладку закрыли — уборка удаляет чат
        event = ws_phone.receive_json()
        while event["type"] == "presence":  # сначала приходят статусы «в сети / не в сети»
            event = ws_phone.receive_json()
    assert event == {"type": "chat_removed", "chat_id": chat_id, "reason": "pc_left"}
    assert not (tmp_path / "files" / chat_id).exists()
    assert phone.get("/api/phone/chats").json()["chats"] == []
    assert open_pc(pc)["linked"] is False  # компьютер начнёт с нового QR


def test_temp_chat_lives_while_tab_open(client, pc, phone, settings):
    pair(pc, phone)
    settings.pc_grace_sec = 0
    with pc.ws() as ws:
        ws.receive_json()
        client.portal.call(store(client).cleanup)
        assert len(phone.get("/api/phone/chats").json()["chats"]) == 1


def test_remember_pc_keeps_chat_after_tab_closed(client, pc, phone, settings):
    chat_id = pair(pc, phone)
    r = pc.post("/api/pc/mode", json={"mode": "remember"})
    assert r.status_code == 200
    assert f"Max-Age={settings.remember_days * 86400}" in pc.raw_cookies["pd_pc"]
    send_text(phone, "прочитаю потом", chat_id)
    settings.pc_grace_sec = 0
    with pc.ws() as ws:
        ws.receive_json()
    client.portal.call(store(client).cleanup)
    state = open_pc(pc)
    assert state["linked"] and [m["text"] for m in state["messages"]] == ["прочитаю потом"]


def test_data_survives_server_restart(settings, tmp_path):
    """Деплой = перезапуск контейнера. «Свой» компьютер и переписка должны остаться."""
    with TestClient(create_app(settings), base_url=BASE) as c1:
        pc, phone = Device(c1, "pc"), Device(c1, "phone")
        chat_id = pair(pc, phone)
        pc.post("/api/pc/mode", json={"mode": "remember"})
        phone.post("/api/send", data={"chat_id": chat_id}, files={"files": ("a.txt", b"abc", "text/plain")})
    with TestClient(create_app(settings), base_url=BASE) as c2:
        pc.client = phone.client = c2
        messages = pc.get("/api/state").json()["messages"]
        assert messages[0]["name"] == "a.txt"
        assert pc.get(messages[0]["url"]).content == b"abc"
        assert phone.get("/api/phone/chats").json()["chats"][0]["id"] == chat_id


def test_temp_chat_survives_quick_restart(settings):
    """«Чужой» компьютер не должен терять чат из-за деплоя: после старта есть время переподключиться."""
    with TestClient(create_app(settings), base_url=BASE) as c1:
        pc, phone = Device(c1, "pc"), Device(c1, "phone")
        pair(pc, phone)
        c1.app.state.store.run("UPDATE devices SET last_seen=0")  # будто давно не было на связи
    with TestClient(create_app(settings), base_url=BASE) as c2:
        c2.portal.call(c2.app.state.store.cleanup)
        phone.client = c2
        assert len(phone.get("/api/phone/chats").json()["chats"]) == 1


def test_old_files_expire_but_text_stays(client, pc, phone, settings, tmp_path):
    chat_id = pair(pc, phone)
    send_text(phone, "текст остаётся", chat_id)
    m = phone.post("/api/send", data={"chat_id": chat_id},
                   files={"files": ("old.txt", b"abc", "text/plain")}).json()["messages"][0]
    store(client).run("UPDATE messages SET created=? WHERE id=?", time.time() - 31 * 86400, m["id"])
    pc.post("/api/pc/mode", json={"mode": "remember"})
    client.portal.call(store(client).cleanup)
    messages = pc.get("/api/state").json()["messages"]
    expired = next(x for x in messages if x["id"] == m["id"])
    assert expired["expired"] is True and "url" not in expired
    assert any(x.get("text") == "текст остаётся" for x in messages)
    assert pc.get(f"/f/{m['id']}").status_code == 410
    assert not (tmp_path / "files" / chat_id / m["id"]).exists()


def test_phone_removes_computer(pc, phone):
    chat_id = pair(pc, phone)
    with pc.ws() as ws_pc:
        ws_pc.receive_json()
        assert phone.delete(f"/api/chats/{chat_id}").status_code == 200
        assert ws_pc.receive_json() == {"type": "closed", "reason": "phone_removed"}
    assert pc.get("/api/state").status_code == 401


def test_pc_logout(pc, phone):
    pair(pc, phone)
    assert pc.post("/api/pc/logout").status_code == 200
    assert "pd_pc" not in pc.cookies
    assert phone.get("/api/phone/chats").json()["chats"] == []


# ------------------------------------------------------------ уведомления


def test_push_notifications_both_ways(client, pc, phone):
    chat_id = pair(pc, phone)
    sub_pc = {"endpoint": "https://push.example/pc", "keys": {"p256dh": "a" * 87, "auth": "b" * 22}}
    sub_phone = {"endpoint": "https://push.example/phone", "keys": {"p256dh": "c" * 87, "auth": "d" * 22}}
    assert pc.post("/api/push/subscribe", json=sub_pc).status_code == 200
    assert phone.post("/api/push/subscribe", json=sub_phone).status_code == 200

    send_text(phone, "смотри файл", chat_id)
    send_text(pc, "ок, принял")
    client.portal.call(store(client).flush_push)
    sent = dict(client.pusher.sent)
    assert '"смотри файл"' in sent["https://push.example/pc"]
    assert '"ок, принял"' in sent["https://push.example/phone"]
    assert f'"/chat?c={chat_id}"' in sent["https://push.example/phone"]


def test_dead_push_subscription_removed(client, pc, phone):
    chat_id = pair(pc, phone)
    sub = {"endpoint": "https://push.example/old", "keys": {"p256dh": "a" * 87, "auth": "b" * 22}}
    pc.post("/api/push/subscribe", json=sub)
    client.pusher.gone.add(sub["endpoint"])
    send_text(phone, "x", chat_id)
    client.portal.call(store(client).flush_push)
    assert store(client).q("SELECT * FROM push_subs") == []


def test_push_subscription_validated(pc, phone):
    pair(pc, phone)
    bad = {"endpoint": "http://not-https.example", "keys": {"p256dh": "a", "auth": "b"}}
    assert pc.post("/api/push/subscribe", json=bad).status_code == 400
    assert pc.post("/api/push/subscribe", json={"nope": 1}).status_code == 400


# ------------------------------------------------------------ безопасность


def test_security_headers(client):
    r = client.get("/")
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["cache-control"] == "no-store"


def test_pages_have_no_inline_scripts():
    # Строгая CSP запрещает встроенные скрипты — проверяем, что их нет.
    for page in ("desktop.html", "phone.html"):
        html = (STATIC_DIR / page).read_text(encoding="utf-8")
        assert "<script>" not in html and "onclick=" not in html and "style=" not in html, page


def test_tokens_stored_only_as_hashes(client, pc, phone, tmp_path):
    pair(pc, phone)
    store(client).db.execute("PRAGMA wal_checkpoint(FULL)")
    raw = b"".join(p.read_bytes() for p in tmp_path.glob("phonedrop.db*"))
    for token in (pc.cookies["pd_pc"], phone.cookies["pd_phone"]):
        assert token.encode() not in raw


def test_api_needs_pairing(phone):
    assert phone.get("/api/phone/chats").status_code == 401
    assert send_text(phone, "hi", "whatever").status_code == 401


def test_api_needs_role_header(pc):
    open_pc(pc)
    assert pc.post("/api/pc/session", headers={"X-PD-Role": None}).status_code == 400


def test_phone_cannot_do_pc_actions(pc, phone):
    pair(pc, phone)
    assert phone.post("/api/pc/logout").status_code == 403
    assert phone.post("/api/pc/mode", json={"mode": "remember"}).status_code == 403


def test_qr_code_is_one_time(client, pc, phone):
    code = code_of(open_pc(pc))
    assert phone.post(f"/api/pair/{code}").status_code == 200
    assert Device(client, "phone").post(f"/api/pair/{code}").status_code == 410


def test_expired_qr_code_rejected(client, pc, phone):
    code = code_of(open_pc(pc))
    store(client).run("UPDATE devices SET pair_expires=?", time.time() - 1)
    assert phone.post(f"/api/pair/{code}").status_code == 410


def test_wrong_qr_code_rejected(phone):
    assert phone.post("/api/pair/guess-123").status_code == 410


def test_cross_site_requests_blocked(pc, phone):
    chat_id = pair(pc, phone)
    evil = {"Origin": "https://evil.example"}
    assert phone.post("/api/send", headers=evil, data={"text": "x", "chat_id": chat_id}).status_code == 403
    assert pc.post("/api/pc/logout", headers=evil).status_code == 403


def test_cross_site_websocket_blocked(pc):
    open_pc(pc)
    with pytest.raises(Exception):
        with pc.ws({"Origin": "https://evil.example"}) as ws:
            ws.receive_json()


def test_strangers_cannot_read_chats_or_files(client, pc, phone):
    chat_id = pair(pc, phone)
    m = phone.post("/api/send", data={"chat_id": chat_id},
                   files={"files": ("secret.txt", b"top secret", "text/plain")}).json()["messages"][0]

    stranger_pc, stranger_phone = Device(client, "pc"), Device(client, "phone")
    pair(stranger_pc, stranger_phone)  # у чужого свой аккаунт и свой чат
    assert stranger_pc.get(m["url"]).status_code == 404
    assert stranger_phone.get(m["url"]).status_code == 404
    assert stranger_phone.get(f"/api/chats/{chat_id}").status_code == 404
    assert send_text(stranger_phone, "влезу", chat_id).status_code == 404
    assert stranger_phone.delete(f"/api/messages/{m['id']}").status_code == 404
    assert Device(client, "pc").get(m["url"]).status_code == 404  # совсем без cookie


def test_my_second_pc_cannot_read_first_pc_chat(client, pc, phone):
    chat_id = pair(pc, phone)
    m = phone.post("/api/send", data={"chat_id": chat_id},
                   files={"files": ("home.txt", b"home", "text/plain")}).json()["messages"][0]
    work_pc = Device(client, "pc")
    pair(work_pc, phone)
    assert work_pc.get(m["url"]).status_code == 404  # рабочий компьютер не видит домашний чат


def test_dangerous_files_never_open_in_browser(pc, phone):
    pair(pc, phone)
    for name, mime in (("evil.html", "text/html"), ("evil.svg", "image/svg+xml")):
        m = pc.post("/api/send", files={"files": (name, b"<script>alert(1)</script>", mime)}).json()["messages"][0]
        r = pc.get(m["url"])
        assert r.headers["content-disposition"].startswith("attachment"), name
        assert r.headers["content-type"] == "application/octet-stream"
        assert r.headers["content-security-policy"] == "sandbox"


def test_path_traversal_in_filename_is_harmless(pc, phone, tmp_path):
    pair(pc, phone)
    for evil in ("../../etc/passwd", "..\\..\\windows\\win.ini"):
        m = pc.post("/api/send", files={"files": (evil, b"x", "text/plain")}).json()["messages"][0]
        assert "/" not in m["name"] and "\\" not in m["name"]
    assert not (tmp_path / "etc").exists()


def test_upload_size_limit(pc, phone):
    pair(pc, phone)
    big = b"0" * (2 * 1024 * 1024)  # 2 МБ при лимите 1 МБ
    assert pc.post("/api/send", files={"files": ("big.bin", big)}).status_code == 413


def test_upload_limit_without_content_length(client, pc, phone):
    # Хитрая загрузка «по кусочкам» без заголовка размера тоже обрывается на лимите.
    pair(pc, phone)
    boundary = "XyZ"
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"big.bin\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n").encode()

    def body():
        yield head
        for _ in range(3):
            yield b"0" * (1024 * 1024)
        yield f"\r\n--{boundary}--\r\n".encode()

    client.cookies.clear()
    headers = pc.headers({"Content-Type": f"multipart/form-data; boundary={boundary}"})
    r = client.post("/api/send", content=body(), headers=headers)
    assert "content-length" not in {k.lower() for k in r.request.headers}
    assert r.status_code == 413


def test_chat_disk_quota(client, pc, phone, tmp_path):
    chat_id = pair(pc, phone)
    chunk = b"0" * (900 * 1024)
    assert pc.post("/api/send", files={"files": ("1.bin", chunk)}).status_code == 200
    assert pc.post("/api/send", files={"files": ("2.bin", chunk)}).status_code == 200
    assert pc.post("/api/send", files={"files": ("3.bin", chunk)}).status_code == 413  # квота 2 МБ
    assert len(list((tmp_path / "files" / chat_id).iterdir())) == 2  # «сирот» на диске нет


def test_too_long_text_rejected(pc, phone):
    pair(pc, phone)
    assert send_text(pc, "a" * 20_001).status_code in (400, 413)


def test_rate_limit_on_new_computers(settings):
    settings.devices_per_ip = 3
    with TestClient(create_app(settings), base_url=BASE) as c:
        codes = [Device(c, "pc").post("/api/pc/session").status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]


def test_max_computers_per_phone(client, phone):
    for i in range(MAX_DEVICES + 1):
        status = phone.post(f"/api/pair/{code_of(open_pc(Device(client, 'pc')))}").status_code
        assert status == (200 if i < MAX_DEVICES else 409)
