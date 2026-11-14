"""v2.0: русский, English, עברית. Проверяем, что ни одна фраза не осталась без перевода
и что сервер отвечает человеку на его языке: ошибки, push-уведомления, имена файлов."""

import ast
import json
import re
import string
from pathlib import Path

from app.i18n import DICTS, T, pick_lang, tr
from test_app import as_room, pair, send_text, store

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"
CYR = re.compile("[А-Яа-яЁё]")


def fields(text: str) -> set[str]:
    return {f for _, f, _, _ in string.Formatter().parse(text) if f}


def server_phrases() -> set[str]:
    """Все русские строки из app/main.py и app/nettools.py, кроме комментариев, docstring'ов и SQL."""
    found = set()
    for name in ("main.py", "nettools.py"):
        found |= file_phrases(ROOT / "app" / name)
    return found


def file_phrases(path: Path) -> set[str]:
    tree = ast.parse(path.read_text("utf-8"))
    docs = {id(n.body[0].value) for n in ast.walk(tree)
            if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    found = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.JoinedStr):
            text = "".join(v.value for v in n.values if isinstance(v, ast.Constant))
            assert not CYR.search(text), f"строка {n.lineno}: f-строку для человека пиши через T(...)"
        if (isinstance(n, ast.Constant) and isinstance(n.value, str) and CYR.search(n.value)
                and id(n) not in docs and "CREATE TABLE" not in n.value):
            found.add(n.value)
    return found


def test_every_server_phrase_is_translated():
    phrases = server_phrases()
    assert len(phrases) > 100
    for lang, words in DICTS.items():
        missing = phrases - words.keys()
        assert not missing, f"{lang}: нет перевода для {sorted(missing)[:5]}"
        for ru, other in words.items():
            assert fields(ru) == fields(other), f"{lang}: подстановки не совпадают в «{ru}»"
            assert not CYR.search(other), f"{lang}: в переводе остался русский: {other}"


def test_translate_templates_and_plain_text():
    msg = T("Не больше {MAX_USERS} пользователей", MAX_USERS=100)
    assert msg == "Не больше 100 пользователей"  # по-русски это обычная строка
    assert tr(msg, "en") == "No more than 100 users"
    assert tr(msg, "he") == "לא יותר מ-100 משתמשים"
    assert tr("Файл не найден", "en") == "File not found"
    assert tr("моё сообщение", "en") == "моё сообщение"  # текст людей не трогаем
    nested = T("Не получилось показать документ: {detail}", detail="Файл не найден")
    assert tr(nested, "en") == "Couldn't show the document: File not found"


def test_language_choice():
    assert pick_lang("he", "ru-RU") == "he"  # выбор в приложении важнее языка браузера
    assert pick_lang(None, "he-IL,he;q=0.9") == "he"
    assert pick_lang(None, "uk-UA,uk;q=0.9") == "ru"
    assert pick_lang(None, "fr-FR") == "en"
    assert pick_lang(None, None) == "ru"
    assert pick_lang("xx", "en-US") == "en"  # мусор в cookie игнорируем


def test_errors_come_in_my_language(pc, phone):
    chat_id = pair(pc, phone)
    phone.cookies["pd_lang"] = "he"
    r = send_text(phone, "x" * 20001, chat_id)
    assert r.status_code == 413, r.text
    assert "הטקסט ארוך מדי" in r.json()["detail"]
    del phone.cookies["pd_lang"]
    r = phone.post("/api/pair/000000", headers={"Accept-Language": "en-US,en;q=0.9"})
    assert r.json()["detail"].startswith("Code is invalid")


def test_push_comes_in_language_of_that_phone(client, pc, phone):
    chat_id = pair(pc, phone)
    phone.cookies["pd_lang"] = "en"
    sub = {"endpoint": "https://push.example/en", "keys": {"p256dh": "a" * 87, "auth": "b" * 22}}
    assert phone.post("/api/push/subscribe", json=sub).status_code == 200
    pc.cookies["pd_lang"] = "he"
    pc_sub = {"endpoint": "https://push.example/he", "keys": {"p256dh": "c" * 87, "auth": "d" * 22}}
    assert pc.post("/api/push/subscribe", json=pc_sub).status_code == 200
    r = phone.post("/api/send", files={"voice": ("voice.webm", b"OggS-fake", "audio/webm")},
                   data={"duration": "3", "chat_id": chat_id})
    assert r.status_code == 200, r.text
    send_text(pc, "привет")
    client.portal.call(store(client).flush_push)
    sent = {k: json.loads(v) for k, v in client.pusher.sent}
    assert sent["https://push.example/he"]["title"] == "📱 טלפון"
    assert sent["https://push.example/he"]["body"] == "🎤 הודעה קולית"
    assert sent["https://push.example/en"]["body"] == "привет"  # сами сообщения людей не переводим


def test_old_push_subscriptions_get_language_column(client):
    cols = {r["name"] for r in store(client).q("PRAGMA table_info(push_subs)")}
    assert "lang" in cols


def test_room_join_push_in_owner_language(client, pc, phone):
    pair(pc, phone)
    phone.cookies["pd_lang"] = "he"
    sub = {"endpoint": "https://push.example/owner", "keys": {"p256dh": "a" * 87, "auth": "b" * 22}}
    phone.post("/api/push/subscribe", json=sub)
    rid = phone.post("/api/rooms", json={"title": "Ира", "owner_name": "Роман"}).json()["room"]["id"]
    code = as_room(phone).post(f"/api/rooms/{rid}/invite").json()["code"]
    r = phone.client.post("/api/get/code", json={"code": code},
                          headers={"X-PD-Role": "room", "Origin": "https://testserver"})
    assert r.status_code == 200, r.text
    client.portal.call(store(client).flush_push)
    sent = {k: json.loads(v) for k, v in client.pusher.sent}
    assert sent["https://push.example/owner"]["title"] == "✅ Ира הצטרף לצ'אט"



# ------------------------------------------------------------ интерфейс (JS и HTML)

def test_every_interface_phrase_is_translated():
    from i18n_phrases import html_phrases, js_phrases, words

    phrases = js_phrases() | html_phrases()
    assert len(phrases) > 400
    dicts = words()
    for lang in ("en", "he"):
        missing = phrases - dicts[lang].keys()
        assert not missing, f"{lang}: нет перевода для {sorted(missing)[:5]}"
        for ru in phrases:
            other = dicts[lang][ru]
            assert sorted(re.findall(r"\{\d+\}", ru)) == sorted(re.findall(r"\{\d+\}", other)), ru
            assert not CYR.search(other), f"{lang}: в переводе остался русский: {other}"


def test_no_russian_text_outside_tx():
    """Новый текст в JS пишем через tx("…") — иначе он не переведётся."""
    literal = re.compile(r"""tx\(\s*"(?:[^"\\]|\\.)*"|tx\(\s*'(?:[^'\\]|\\.)*'""")
    for f in STATIC.glob("*.js"):
        if f.name.startswith("i18n") or f.name == "sw.js" or f.name.startswith("vendor"):
            continue
        for no, line in enumerate(f.read_text("utf-8").splitlines(), 1):
            code = literal.sub("", line)
            code = re.sub(r"/\*.*?\*/", "", code)
            code = re.sub(r"//.*", "", code)
            if code.lstrip().startswith("*"):
                continue
            assert not CYR.search(code), f"{f.name}:{no}: русский текст без tx(): {line.strip()}"


def test_pages_load_languages_before_app(client):
    for path in ("/", "/chat", "/get"):
        html = client.get(path).text
        assert html.index("/static/i18n-words.js") < html.index("/static/i18n.js") < html.index("/static/chat.js")
        assert "data-lang-pick" in html
    assert client.get("/static/i18n-words.js").status_code == 200
