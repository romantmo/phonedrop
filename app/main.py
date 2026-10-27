"""PhoneDrop — чат между телефоном и твоими компьютерами по QR-коду.

Как это устроено (похоже на WhatsApp Web):
- Телефон — это «аккаунт». Он получает секретный ключ при первом сканировании QR-кода.
- Компьютер подключается к телефону по одноразовому QR-коду. У каждого компьютера свой чат.
- Режим компьютера:
    «чужой»  — переписка удаляется через минуту после закрытия вкладки (по умолчанию);
    «мой»    — компьютер запоминается, переписка сохраняется (файлы — 30 дней).
- Новые сообщения приходят мгновенно (WebSocket), а если приложение закрыто — push-уведомлением.
- Данные хранятся в SQLite и папке с файлами (DATA_DIR) и переживают перезапуск сервера.

Модель безопасности описана в SECURITY.md.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import time
import uuid
import zipfile
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
import qrcode
import qrcode.image.svg
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import (
    FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, UploadFile

STATIC_DIR = Path(__file__).parent / "static"
PC_COOKIE = "pd_pc"
PHONE_COOKIE = "pd_phone"
ROLE_HEADER = "x-pd-role"
ROLES = ("pc", "phone")
MODES = ("temp", "remember")
MB = 1024 * 1024
DAY = 86400
MAX_TEXT_CHARS = 20_000
MAX_DEVICES = 10
MAX_VOICE_SEC = 600
PHONE_COOKIE_DAYS = 365

# Что можно показывать прямо в браузере. Всё остальное (html, svg, exe...) — только скачивание.
INLINE_SAFE_PREFIXES = ("video/", "audio/")
INLINE_SAFE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "application/pdf",
    "text/plain",
}


def viewable(mime: str | None) -> bool:
    """Можно ли открыть файл прямо в браузере (а не только скачать)."""
    mime = mime or ""
    return mime in INLINE_SAFE_TYPES or mime.startswith(INLINE_SAFE_PREFIXES)


# Как защищаем открытый файл. Обычно — «песочница»: даже если в файле спрятан скрипт,
# он не запустится и не получит доступ к сайту. Но встроенный просмотрщик PDF в Chrome
# в песочнице не работает, поэтому PDF отдаём без неё. Это безопасно: PDF не может
# стать веб-страницей (точный тип + nosniff), а его собственные скрипты браузер
# выполняет отдельно от сайта, без доступа к cookie и нашим API.
def file_csp(mime: str) -> str | None:
    return None if mime == "application/pdf" else "sandbox"


# ------------------------------------------------------------ конвертация
# Документы, которые конвертер умеет превращать в PDF (через LibreOffice).
OFFICE_EXTS = {
    "doc", "docx", "docm", "odt", "rtf",
    "xls", "xlsx", "xlsm", "ods", "csv",
    "ppt", "pptx", "pps", "ppsx", "odp",
}
HEIC_EXTS = {"heic", "heif"}
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "avif"} | HEIC_EXTS
TOOL_OPS = ("office-pdf", "images-pdf", "merge-pdf", "pdf-images", "images-jpg", "compress-pdf")


def file_ext(name: str | None) -> str:
    return Path(name or "").suffix.lower().lstrip(".")


def stem(name: str | None) -> str:
    return Path(name or "file").stem or "file"


def is_image(name: str | None, mime: str | None) -> bool:
    if mime == "image/svg+xml" or file_ext(name) == "svg":
        return False  # SVG — это код, а не фото
    return (mime or "").startswith("image/") or file_ext(name) in IMAGE_EXTS


def is_pdf(name: str | None, mime: str | None) -> bool:
    return mime == "application/pdf" or file_ext(name) == "pdf"


def convert_to(name: str | None, mime: str | None) -> str | None:
    """Во что можно превратить файл прямо в чате: Word/Excel/PowerPoint → PDF, HEIC → JPG."""
    ext = file_ext(name)
    if ext in OFFICE_EXTS:
        return "pdf"
    if ext in HEIC_EXTS or mime in ("image/heic", "image/heif"):
        return "jpg"
    return None

# Content-Security-Policy: браузер выполняет только наши скрипты и стили с этого же сайта.
# Даже если кто-то пришлёт в чат текст со скриптом, он не запустится.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; "
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; "
    "manifest-src 'self'; worker-src 'self'; connect-src 'self'"
)
HOST_RE = re.compile(r"[A-Za-z0-9.\-:\[\]]+")

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT UNIQUE NOT NULL,
    created     REAL NOT NULL,
    last_active REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT UNIQUE NOT NULL,
    account_id    TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    label         TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'temp',
    created       REAL NOT NULL,
    last_seen     REAL NOT NULL,
    pair_hash     TEXT UNIQUE,
    pair_expires  REAL NOT NULL DEFAULT 0,
    used_bytes    INTEGER NOT NULL DEFAULT 0,
    phone_read_at REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
    id        TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sender    TEXT NOT NULL,
    kind      TEXT NOT NULL,
    created   REAL NOT NULL,
    text      TEXT,
    name      TEXT,
    size      INTEGER NOT NULL DEFAULT 0,
    mime      TEXT,
    duration  REAL,
    expired   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_by_device ON messages(device_id, created);
CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    owner    TEXT NOT NULL,
    p256dh   TEXT NOT NULL,
    auth     TEXT NOT NULL,
    created  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS push_by_owner ON push_subs(owner);
CREATE TABLE IF NOT EXISTS tool_results (
    id      TEXT PRIMARY KEY,
    owner   TEXT NOT NULL,
    name    TEXT NOT NULL,
    mime    TEXT NOT NULL,
    size    INTEGER NOT NULL,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_results_by_owner ON tool_results(owner, created);
CREATE TABLE IF NOT EXISTS transfers (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    from_dev   TEXT,
    from_label TEXT NOT NULL,
    to_dev     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mime       TEXT,
    received   INTEGER NOT NULL DEFAULT 0,
    created    REAL NOT NULL,
    done       REAL
);
CREATE INDEX IF NOT EXISTS transfers_by_account ON transfers(account_id);
CREATE TABLE IF NOT EXISTS shares (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    owner       TEXT NOT NULL,
    owner_label TEXT NOT NULL,
    token_hash  TEXT UNIQUE NOT NULL,
    code_hash   TEXT UNIQUE NOT NULL,
    pw_salt     TEXT,
    pw_hash     TEXT,
    once        INTEGER NOT NULL DEFAULT 0,
    notify      INTEGER NOT NULL DEFAULT 1,
    created     REAL NOT NULL,
    expires     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS share_files (
    id        TEXT PRIMARY KEY,
    share_id  TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    mime      TEXT,
    received  INTEGER NOT NULL DEFAULT 0,
    done      REAL,
    downloads INTEGER NOT NULL DEFAULT 0,
    created   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS share_access (
    key_hash TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    expires  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS share_sessions (
    key_hash TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    expires  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_pages (
    id      TEXT PRIMARY KEY,
    owner   TEXT NOT NULL,
    name    TEXT NOT NULL,
    created REAL NOT NULL
);
"""


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def token_hash(token: str) -> str:
    # В базе лежат только хэши ключей: даже утечка базы не даст войти в чужой чат.
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- настройки


@dataclass
class Settings:
    """Все настройки берутся из переменных окружения — удобно для Docker."""

    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", "/tmp/phonedrop")))
    public_url: str = field(default_factory=lambda: os.getenv("PUBLIC_URL", "").rstrip("/"))
    max_upload_mb: int = field(default_factory=lambda: _env_int("MAX_UPLOAD_MB", 500))
    chat_quota_mb: int = field(default_factory=lambda: _env_int("CHAT_QUOTA_MB", 4096))
    min_free_disk_mb: int = field(default_factory=lambda: _env_int("MIN_FREE_DISK_MB", 2048))
    file_ttl_days: int = field(default_factory=lambda: _env_int("FILE_TTL_DAYS", 30))
    remember_days: int = field(default_factory=lambda: _env_int("REMEMBER_DAYS", 90))
    pc_grace_sec: int = field(default_factory=lambda: _env_int("PC_GRACE_SEC", 60))
    pair_ttl_sec: int = field(default_factory=lambda: _env_int("PAIR_TTL_SEC", 300))
    max_pending: int = field(default_factory=lambda: _env_int("MAX_PENDING", 500))
    devices_per_ip: int = field(default_factory=lambda: _env_int("DEVICES_PER_IP_PER_10MIN", 30))
    sends_per_min: int = field(default_factory=lambda: _env_int("SENDS_PER_MIN", 120))
    vapid_subject: str = field(default_factory=lambda: os.getenv("VAPID_SUBJECT", ""))
    cleanup_interval_sec: int = field(default_factory=lambda: _env_int("CLEANUP_INTERVAL_SEC", 30))
    # Конвертер — отдельный контейнер во внутренней сети (см. converter/main.py).
    converter_url: str = field(default_factory=lambda: os.getenv("CONVERTER_URL", "http://converter:8001"))
    tool_max_mb: int = field(default_factory=lambda: _env_int("TOOL_MAX_MB", 100))
    tool_ttl_min: int = field(default_factory=lambda: _env_int("TOOL_TTL_MIN", 30))
    tools_per_min: int = field(default_factory=lambda: _env_int("TOOLS_PER_MIN", 20))
    # Передачи между компьютерами: большие файлы по частям, хранятся сутки.
    transfer_max_mb: int = field(default_factory=lambda: _env_int("TRANSFER_MAX_MB", 10240))
    transfer_quota_mb: int = field(default_factory=lambda: _env_int("TRANSFER_QUOTA_MB", 20480))
    transfer_ttl_hours: int = field(default_factory=lambda: _env_int("TRANSFER_TTL_HOURS", 24))
    transfer_chunk_mb: int = field(default_factory=lambda: _env_int("TRANSFER_CHUNK_MB", 8))
    # Вход через Google. Ключи лежат только на сервере (файл .env), не в GitHub.
    google_client_id: str = field(default_factory=lambda: os.getenv("GOOGLE_CLIENT_ID", ""))
    google_client_secret: str = field(default_factory=lambda: os.getenv("GOOGLE_CLIENT_SECRET", ""))
    allowed_emails: set = field(default_factory=lambda: {
        e.strip().lower() for e in os.getenv("ALLOWED_EMAILS", "").split(",") if e.strip()})

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def login_required(self) -> bool:
        # Как только включён вход через Google, новые телефоны без него аккаунт не получают.
        return self.google_enabled


class PushGone(Exception):
    """Подписка на уведомления больше не действует (браузер её удалил)."""


# ------------------------------------------------------------- хранилище


class Store:
    """База SQLite + файлы на диске + живые WebSocket-соединения."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.files_root = settings.data_dir / "files"
        self.tools_root = settings.data_dir / "tools"  # результаты инструментов (живут 30 минут)
        self.tmp_root = settings.data_dir / "tmp"
        self.transfers_root = settings.data_dir / "transfers"
        self.transfer_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.converter_transport = None  # в тестах сюда подставляется конвертер «в памяти»
        self.google_transport = None     # в тестах — «поддельный Google»
        self.preview_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.db: sqlite3.Connection | None = None
        self.pc_sockets: dict[str, set[WebSocket]] = defaultdict(set)  # компьютер -> соединения
        self.phone_sockets: dict[str, set[WebSocket]] = defaultdict(set)  # аккаунт -> соединения
        self.vapid = None
        self.vapid_public = ""
        self.push_sender = self._send_webpush
        self.push_tasks: set[asyncio.Task] = set()

    # ---------- запуск
    def open(self) -> None:
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.files_root.mkdir(parents=True, exist_ok=True)
        self.tools_root.mkdir(parents=True, exist_ok=True)
        self.transfers_root.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp_root, ignore_errors=True)  # остатки прерванных конвертаций
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(
            self.settings.data_dir / "phonedrop.db", check_same_thread=False, isolation_level=None
        )
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        self._migrate()
        # После перезапуска (например, деплоя) даём «чужим» компьютерам время переподключиться.
        self.run("UPDATE devices SET last_seen=? WHERE mode='temp' OR account_id IS NULL", time.time())
        self._load_vapid()
        self._load_secret()

    def _migrate(self) -> None:
        """Новые колонки для уже существующей базы (на сервере база живёт между версиями)."""
        def add(table: str, column: str, ddl: str) -> None:
            if column not in {r["name"] for r in self.q(f"PRAGMA table_info({table})")}:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        add("accounts", "google_sub", "google_sub TEXT")
        add("accounts", "email", "email TEXT")
        add("shares", "kind", "kind TEXT NOT NULL DEFAULT 'send'")
        add("shares", "max_bytes", "max_bytes INTEGER NOT NULL DEFAULT 0")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS accounts_by_google ON accounts(google_sub) "
                        "WHERE google_sub IS NOT NULL")

    def close(self) -> None:
        if self.db:
            self.db.close()

    def _load_secret(self) -> None:
        # Секрет сервера: им «подписываются» отпечатки ссылок и кодов посылок.
        path = self.settings.data_dir / "secret.key"
        if not path.exists():
            path.write_bytes(secrets.token_bytes(32))
            path.chmod(0o600)
        self.secret = path.read_bytes()

    def keyed_hash(self, value: str) -> str:
        return hmac.new(self.secret, value.encode(), hashlib.sha256).hexdigest()

    def _load_vapid(self) -> None:
        # Ключ VAPID подписывает наши push-уведомления. Создаётся один раз и хранится в DATA_DIR.
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid01

        path = self.settings.data_dir / "vapid_private.pem"
        if path.exists():
            self.vapid = Vapid01.from_file(str(path))
        else:
            self.vapid = Vapid01()
            self.vapid.generate_keys()
            path.write_bytes(self.vapid.private_pem())
            path.chmod(0o600)
        raw = self.vapid.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        self.vapid_public = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    # ---------- SQL-помощники
    def q(self, sql: str, *args) -> list[sqlite3.Row]:
        return self.db.execute(sql, args).fetchall()

    def one(self, sql: str, *args) -> sqlite3.Row | None:
        return self.db.execute(sql, args).fetchone()

    def run(self, sql: str, *args) -> int:
        return self.db.execute(sql, args).rowcount

    # ---------- аккаунты и компьютеры
    def account_by_token(self, token: str | None) -> sqlite3.Row | None:
        return self.one("SELECT * FROM accounts WHERE token_hash=?", token_hash(token)) if token else None

    def device_by_token(self, token: str | None) -> sqlite3.Row | None:
        return self.one("SELECT * FROM devices WHERE token_hash=?", token_hash(token)) if token else None

    def device(self, device_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM devices WHERE id=?", device_id)

    def create_device(self, label: str) -> tuple[sqlite3.Row, str]:
        pending = self.one("SELECT COUNT(*) AS n FROM devices WHERE account_id IS NULL")["n"]
        if pending >= self.settings.max_pending:
            raise HTTPException(503, "Сервер перегружен, попробуй через пару минут")
        token = secrets.token_urlsafe(32)
        did = uuid.uuid4().hex
        now = time.time()
        self.run(
            "INSERT INTO devices (id, token_hash, label, mode, created, last_seen) VALUES (?,?,?,?,?,?)",
            did, token_hash(token), label, "temp", now, now,
        )
        return self.device(did), token

    def new_pair_code(self, device_id: str) -> tuple[str, float]:
        code = secrets.token_urlsafe(24)
        expires = time.time() + self.settings.pair_ttl_sec
        self.run("UPDATE devices SET pair_hash=?, pair_expires=? WHERE id=?", token_hash(code), expires, device_id)
        return code, expires

    def consume_pair_code(self, code: str, phone_token: str | None):
        """Одноразовый код из QR: после подключения он перестаёт работать.
        Возвращает (компьютер, аккаунт, новый ключ телефона или None, старые push-подписки или None)."""
        dev = self.one("SELECT * FROM devices WHERE pair_hash=?", token_hash(code)) if code else None
        if not dev or time.time() > dev["pair_expires"]:
            raise HTTPException(410, "Код недействителен или уже использован. Обнови страницу на компьютере")
        if dev["account_id"]:
            return self.relink_phone(dev, phone_token)
        now = time.time()
        account = self.account_by_token(phone_token)
        new_token = None
        if account is None:
            if self.settings.login_required:
                # Новый человек не может просто так завести аккаунт на твоём сервере — сначала вход через Google.
                raise HTTPException(401, "Сначала войди через Google — кнопка на главном экране приложения")
            account, new_token = self.create_account()
        count = self.one("SELECT COUNT(*) AS n FROM devices WHERE account_id=?", account["id"])["n"]
        if count >= MAX_DEVICES:
            raise HTTPException(409, f"Подключено максимум компьютеров ({MAX_DEVICES}). Отключи ненужные")
        changed = self.run(
            "UPDATE devices SET account_id=?, pair_hash=NULL, pair_expires=0, last_seen=? "
            "WHERE id=? AND account_id IS NULL",
            account["id"], now, dev["id"],
        )
        if not changed:
            raise HTTPException(410, "Код уже использован")
        self.run("UPDATE accounts SET last_active=? WHERE id=?", now, account["id"])
        return self.device(dev["id"]), account, new_token, None

    def link_pc(self, dev: sqlite3.Row, account: sqlite3.Row) -> sqlite3.Row:
        """Подключить компьютер к аккаунту без QR — после входа через Google на самом компьютере."""
        count = self.one("SELECT COUNT(*) AS n FROM devices WHERE account_id=?", account["id"])["n"]
        if count >= MAX_DEVICES:
            raise HTTPException(409, f"Подключено максимум компьютеров ({MAX_DEVICES}). Отключи ненужные")
        self.run("UPDATE devices SET account_id=?, pair_hash=NULL, pair_expires=0, last_seen=? "
                 "WHERE id=? AND account_id IS NULL", account["id"], time.time(), dev["id"])
        return self.device(dev["id"])

    def reattach_pc(self, chat: sqlite3.Row, code: str) -> tuple[sqlite3.Row, sqlite3.Row]:
        """«Переподключить компьютер» с телефона: браузер компьютера потерял вход
        (почистили cookie, другой браузер) и показывает новый QR. Телефон сканирует его,
        и этот браузер получает СТАРЫЙ чат со всей перепиской — новый пустой чат не создаётся.
        Возвращает (новое «пустое» устройство, которое исчезает; чат, который получил новый ключ)."""
        fresh = self.one("SELECT * FROM devices WHERE pair_hash=?", token_hash(code)) if code else None
        if not fresh or fresh["account_id"] or time.time() > fresh["pair_expires"]:
            raise HTTPException(410, "Код недействителен. Обнови страницу на компьютере и отсканируй новый QR")
        # Ключ браузера переносим на старый чат; старый ключ (если где-то остался) перестаёт работать.
        self.run("DELETE FROM devices WHERE id=?", fresh["id"])
        self.run("UPDATE devices SET token_hash=?, last_seen=? WHERE id=?", fresh["token_hash"], time.time(), chat["id"])
        return fresh, self.device(chat["id"])

    def relink_phone(self, dev: sqlite3.Row, phone_token: str | None):
        """Переподключение телефона через «свой» компьютер (телефон переустановили или сбросили).

        Телефон получает НОВЫЙ ключ от аккаунта этого компьютера — старый ключ перестаёт работать,
        поэтому у аккаунта всегда только один телефон. Если на новом телефоне уже были свои
        компьютеры, они переезжают в этот аккаунт — ничего не теряется."""
        if dev["mode"] != "remember":
            raise HTTPException(403, "Переподключать телефон можно только через «Мой компьютер»")
        now = time.time()
        target = self.one("SELECT * FROM accounts WHERE id=?", dev["account_id"])
        current = self.account_by_token(phone_token)
        self.run("UPDATE devices SET pair_hash=NULL, pair_expires=0 WHERE id=?", dev["id"])
        if current and current["id"] == target["id"]:
            return dev, target, None, None  # это и так тот же телефон
        if current and current["google_sub"] and not target["google_sub"]:
            # Телефон уже вошёл через Google, а компьютер — из «старого» аккаунта без Google:
            # переносим компьютеры старого аккаунта в Google-аккаунт, вход через Google сохраняется.
            total = self.one("SELECT COUNT(*) AS n FROM devices WHERE account_id IN (?,?)",
                             target["id"], current["id"])["n"]
            if total > MAX_DEVICES:
                raise HTTPException(409, f"Вместе получится больше {MAX_DEVICES} компьютеров. Отключи ненужные")
            old_subs = self.q("SELECT * FROM push_subs WHERE owner=?", f"acc:{target['id']}")
            for table in ("devices", "transfers", "shares"):
                self.run(f"UPDATE {table} SET account_id=? WHERE account_id=?", current["id"], target["id"])
            self.run("DELETE FROM push_subs WHERE owner=?", f"acc:{target['id']}")
            self.delete_owner_tools(f"acc:{target['id']}")
            self.run("DELETE FROM accounts WHERE id=?", target["id"])
            return self.device(dev["id"]), current, None, old_subs
        target, new_token, old_subs = self.take_over_phone(target, current)
        return dev, target, new_token, old_subs

    def take_over_phone(self, target: sqlite3.Row, current: sqlite3.Row | None):
        """Этот телефон становится телефоном аккаунта target: новый ключ, старый телефон отключается.
        Если у телефона был свой аккаунт без Google — его компьютеры и посылки переезжают в target."""
        merge = current is not None and current["id"] != target["id"] and not current["google_sub"]
        if merge:
            total = self.one("SELECT COUNT(*) AS n FROM devices WHERE account_id IN (?,?)",
                             target["id"], current["id"])["n"]
            if total > MAX_DEVICES:
                raise HTTPException(409, f"Вместе получится больше {MAX_DEVICES} компьютеров. Отключи ненужные")
        old_subs = self.q("SELECT * FROM push_subs WHERE owner=?", f"acc:{target['id']}")
        self.run("DELETE FROM push_subs WHERE owner=?", f"acc:{target['id']}")  # старый телефон больше не получает
        new_token = secrets.token_urlsafe(32)
        self.run("UPDATE accounts SET token_hash=?, last_active=? WHERE id=?", token_hash(new_token), time.time(), target["id"])
        if merge:
            self.run("UPDATE devices SET account_id=? WHERE account_id=?", target["id"], current["id"])
            self.run("UPDATE transfers SET account_id=? WHERE account_id=?", target["id"], current["id"])
            self.run("UPDATE shares SET account_id=? WHERE account_id=?", target["id"], current["id"])
            self.run("UPDATE push_subs SET owner=? WHERE owner=?", f"acc:{target['id']}", f"acc:{current['id']}")
            self.delete_owner_tools(f"acc:{current['id']}")
            self.run("DELETE FROM accounts WHERE id=?", current["id"])
        return self.one("SELECT * FROM accounts WHERE id=?", target["id"]), new_token, old_subs

    def create_account(self, google_sub: str | None = None, email: str | None = None) -> tuple[sqlite3.Row, str]:
        token = secrets.token_urlsafe(32)
        aid = uuid.uuid4().hex
        now = time.time()
        self.run("INSERT INTO accounts (id, token_hash, created, last_active, google_sub, email) VALUES (?,?,?,?,?,?)",
                 aid, token_hash(token), now, now, google_sub, email)
        return self.one("SELECT * FROM accounts WHERE id=?", aid), token

    def delete_device(self, device_id: str) -> None:
        for t in self.q("SELECT id FROM transfers WHERE to_dev=?", device_id):
            self.transfer_path(t["id"]).unlink(missing_ok=True)  # получателя нет — файл не нужен
        self.run("DELETE FROM push_subs WHERE owner=?", f"dev:{device_id}")
        self.run("DELETE FROM devices WHERE id=?", device_id)  # сообщения удалятся каскадом

    def pc_online(self, device_id: str) -> bool:
        return bool(self.pc_sockets.get(device_id))

    def phone_online(self, account_id: str | None) -> bool:
        return bool(account_id and self.phone_sockets.get(account_id))

    # ---------- сообщения
    def message_public(self, row: sqlite3.Row) -> dict:
        data = {"id": row["id"], "chat_id": row["device_id"], "sender": row["sender"],
                "kind": row["kind"], "created": row["created"]}
        if row["kind"] == "text":
            data["text"] = row["text"]
            return data
        data.update(name=row["name"], size=row["size"], mime=row["mime"])
        if row["duration"] is not None:
            data["duration"] = row["duration"]
        if row["expired"]:
            data["expired"] = True
        else:
            data.update(url=f"/f/{row['id']}", download_url=f"/f/{row['id']}?dl=1",
                        viewable=viewable(row["mime"]))
            target = convert_to(row["name"], row["mime"])
            if target:
                data["convert_to"] = target
            if target == "pdf":
                data["preview_url"] = f"/f/{row['id']}/preview"
        return data

    def messages(self, device_id: str) -> list[dict]:
        rows = self.q(
            "SELECT * FROM (SELECT * FROM messages WHERE device_id=? ORDER BY created DESC LIMIT 1000) "
            "ORDER BY created", device_id,
        )
        return [self.message_public(r) for r in rows]

    def file_path(self, device_id: str, mid: str) -> Path:
        return self.files_root / device_id / mid

    def preview_path(self, device_id: str, mid: str) -> Path:
        return self.files_root / device_id / f"{mid}.preview.pdf"

    def remove_file(self, row: sqlite3.Row) -> None:
        self.file_path(row["device_id"], row["id"]).unlink(missing_ok=True)
        self.preview_path(row["device_id"], row["id"]).unlink(missing_ok=True)

    def tool_path(self, rid: str) -> Path:
        return self.tools_root / rid

    # ---------- передачи между компьютерами
    def transfer_path(self, tid: str) -> Path:
        return self.transfers_root / tid

    def delete_transfer(self, tid: str) -> None:
        self.transfer_path(tid).unlink(missing_ok=True)
        self.run("DELETE FROM transfers WHERE id=?", tid)
        self.transfer_locks.pop(tid, None)

    def transfer_public(self, row: sqlite3.Row, me: str) -> dict:
        target = self.device(row["to_dev"])
        data = {
            "id": row["id"], "name": row["name"], "size": row["size"], "mime": row["mime"],
            "received": row["received"], "done": bool(row["done"]), "created": row["created"],
            "expires": row["created"] + self.settings.transfer_ttl_hours * 3600,
            "from_label": row["from_label"], "to_label": target["label"] if target else "?",
            "direction": "in" if row["to_dev"] == me else "out",
        }
        if row["done"]:
            data["url"] = f"/x/{row['id']}"
        return data

    # ---------- посылки (по ссылке и коду)
    def share_path(self, fid: str) -> Path:
        return self.transfers_root / f"s-{fid}"

    def delete_share(self, sid: str) -> None:
        for f in self.q("SELECT id FROM share_files WHERE share_id=?", sid):
            self.share_path(f["id"]).unlink(missing_ok=True)
            self.transfer_locks.pop(f["id"], None)
        self.run("DELETE FROM shares WHERE id=?", sid)  # файлы и сессии удалятся каскадом

    def delete_share_file(self, fid: str) -> None:
        self.share_path(fid).unlink(missing_ok=True)
        self.run("DELETE FROM share_files WHERE id=?", fid)
        self.transfer_locks.pop(fid, None)

    def share_files(self, sid: str) -> list[dict]:
        return [{"id": f["id"], "name": f["name"], "size": f["size"], "mime": f["mime"], "received": f["received"],
                 "done": bool(f["done"]), "downloads": f["downloads"]}
                for f in self.q("SELECT * FROM share_files WHERE share_id=? ORDER BY created", sid)]

    def account_used_bytes(self, account_id: str) -> int:
        a = self.one("SELECT COALESCE(SUM(size), 0) AS n FROM transfers WHERE account_id=?", account_id)["n"]
        b = self.one("SELECT COALESCE(SUM(f.size), 0) AS n FROM share_files f JOIN shares s ON s.id=f.share_id "
                     "WHERE s.account_id=?", account_id)["n"]
        return a + b

    def reserved_bytes(self) -> int:
        """Сколько ещё должно «доехать» во все незаконченные загрузки — это место уже занято."""
        a = self.one("SELECT COALESCE(SUM(size-received), 0) AS n FROM transfers WHERE done IS NULL")["n"]
        b = self.one("SELECT COALESCE(SUM(size-received), 0) AS n FROM share_files WHERE done IS NULL")["n"]
        return a + b

    def scan_path(self, pid: str, kind: str) -> Path:
        # kind: "orig" — фото как есть, "work" — уменьшенная копия для быстрых превью
        return self.tools_root / f"scan-{pid}.{kind}"

    def remove_scan_page(self, pid: str) -> None:
        for kind in ("orig", "work"):
            self.scan_path(pid, kind).unlink(missing_ok=True)
        self.run("DELETE FROM scan_pages WHERE id=?", pid)

    def tool_public(self, row: sqlite3.Row) -> dict:
        return {"id": row["id"], "name": row["name"], "mime": row["mime"], "size": row["size"],
                "url": f"/t/{row['id']}", "download_url": f"/t/{row['id']}?dl=1",
                "viewable": viewable(row["mime"]), "expires": row["created"] + self.settings.tool_ttl_min * 60}

    def delete_message(self, row: sqlite3.Row) -> None:
        if row["kind"] != "text" and not row["expired"]:
            self.remove_file(row)
            self.run("UPDATE devices SET used_bytes=MAX(used_bytes-?,0) WHERE id=?", row["size"], row["device_id"])
        self.run("DELETE FROM messages WHERE id=?", row["id"])

    def chat_summary(self, dev: sqlite3.Row) -> dict:
        last = self.one("SELECT * FROM messages WHERE device_id=? ORDER BY created DESC LIMIT 1", dev["id"])
        unread = self.one(
            "SELECT COUNT(*) AS n FROM messages WHERE device_id=? AND sender='pc' AND created>?",
            dev["id"], dev["phone_read_at"],
        )["n"]
        return {
            "id": dev["id"],
            "label": dev["label"],
            "mode": dev["mode"],
            "pc_online": self.pc_online(dev["id"]),
            "unread": unread,
            "last": {"sender": last["sender"], "preview": preview(last), "created": last["created"]} if last else None,
            "last_seen": dev["last_seen"],
        }

    def phone_chats(self, account_id: str) -> list[dict]:
        devs = self.q("SELECT * FROM devices WHERE account_id=?", account_id)
        chats = [self.chat_summary(d) for d in devs]
        chats.sort(key=lambda c: max(c["last"]["created"] if c["last"] else 0, c["last_seen"]), reverse=True)
        return chats

    # ---------- рассылка событий
    async def send_ws(self, sockets: set[WebSocket], message: dict) -> None:
        for ws in list(sockets):
            try:
                await ws.send_json(message)
            except Exception:
                sockets.discard(ws)

    async def to_chat(self, dev: sqlite3.Row, message: dict) -> None:
        await self.send_ws(self.pc_sockets.get(dev["id"], set()), message)
        if dev["account_id"]:
            await self.send_ws(self.phone_sockets.get(dev["account_id"], set()), message)

    async def presence(self, dev: sqlite3.Row) -> None:
        await self.to_chat(dev, {
            "type": "presence", "chat_id": dev["id"],
            "pc_online": self.pc_online(dev["id"]), "phone_online": self.phone_online(dev["account_id"]),
        })

    async def close_device(self, dev: sqlite3.Row, reason: str) -> None:
        """Отключает компьютер: удаляет его чат и файлы, сообщает обеим сторонам."""
        for ws in list(self.pc_sockets.pop(dev["id"], set())):
            try:
                await ws.send_json({"type": "closed", "reason": reason})
                await ws.close(code=4000)
            except Exception:
                pass
        if dev["account_id"]:
            await self.send_ws(self.phone_sockets.get(dev["account_id"], set()),
                               {"type": "chat_removed", "chat_id": dev["id"], "reason": reason})
        self.delete_device(dev["id"])
        self.delete_owner_tools(f"dev:{dev['id']}")
        # Файлы стираем в фоне: на большой папке это может занять время.
        await run_in_threadpool(shutil.rmtree, self.files_root / dev["id"], True)

    # ---------- push-уведомления
    def _send_webpush(self, info: dict, data: str) -> None:
        from pywebpush import WebPushException, webpush

        subject = self.settings.vapid_subject or (
            self.settings.public_url if self.settings.public_url.startswith("https://") else "mailto:admin@localhost"
        )
        try:
            webpush(info, data=data, vapid_private_key=self.vapid, vapid_claims={"sub": subject},
                    ttl=DAY, timeout=10)
        except WebPushException as exc:
            if exc.response is not None and exc.response.status_code in (404, 410):
                raise PushGone() from exc
            raise

    def push(self, owner: str, payload: dict) -> None:
        for sub in self.q("SELECT * FROM push_subs WHERE owner=?", owner):
            task = asyncio.create_task(self._push_one(sub, payload))
            self.push_tasks.add(task)
            task.add_done_callback(self.push_tasks.discard)

    async def _push_one(self, sub: sqlite3.Row, payload: dict) -> None:
        info = {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}}
        try:
            await run_in_threadpool(self.push_sender, info, json.dumps(payload, ensure_ascii=False))
        except PushGone:
            self.run("DELETE FROM push_subs WHERE endpoint=?", sub["endpoint"])
        except Exception as exc:
            print(f"push error: {type(exc).__name__}")  # содержимое сообщений в логи не пишем

    async def flush_push(self) -> None:
        if self.push_tasks:
            await asyncio.gather(*list(self.push_tasks), return_exceptions=True)

    # ---------- автоматическая уборка
    async def cleanup(self) -> None:
        s = self.settings
        now = time.time()
        # 1) Компьютеры, которые так и не подключили (закрыли вкладку с QR-кодом).
        for dev in self.q("SELECT * FROM devices WHERE account_id IS NULL AND last_seen<?", now - s.pc_grace_sec):
            if not self.pc_online(dev["id"]):
                await self.close_device(dev, "pc_left")
        # 2) «Чужие» компьютеры: вкладку закрыли — удаляем переписку.
        for dev in self.q("SELECT * FROM devices WHERE mode='temp' AND account_id IS NOT NULL AND last_seen<?",
                          now - s.pc_grace_sec):
            if not self.pc_online(dev["id"]):
                await self.close_device(dev, "pc_left")
        # 3) «Свои» компьютеры, на которые давно не заходили.
        for dev in self.q("SELECT * FROM devices WHERE mode='remember' AND last_seen<?", now - s.remember_days * DAY):
            if not self.pc_online(dev["id"]):
                await self.close_device(dev, "expired")
        # 4) Файлы старше срока хранения: файл удаляем, сообщение оставляем с пометкой.
        for row in self.q("SELECT * FROM messages WHERE kind!='text' AND expired=0 AND created<?",
                          now - s.file_ttl_days * DAY):
            self.remove_file(row)
            self.run("UPDATE messages SET expired=1 WHERE id=?", row["id"])
            self.run("UPDATE devices SET used_bytes=MAX(used_bytes-?,0) WHERE id=?", row["size"], row["device_id"])
        # 5) Аккаунты без компьютеров, которыми давно не пользовались.
        for acc in self.q("SELECT * FROM accounts WHERE last_active<? AND NOT EXISTS "
                          "(SELECT 1 FROM devices WHERE account_id=accounts.id)", now - s.file_ttl_days * DAY):
            if not self.phone_online(acc["id"]):
                self.run("DELETE FROM push_subs WHERE owner=?", f"acc:{acc['id']}")
                self.run("DELETE FROM accounts WHERE id=?", acc["id"])
        # 6) Результаты инструментов: хранятся недолго, только чтобы успеть скачать или поделиться.
        for row in self.q("SELECT * FROM tool_results WHERE created<?", now - s.tool_ttl_min * 60):
            self.tool_path(row["id"]).unlink(missing_ok=True)
            self.run("DELETE FROM tool_results WHERE id=?", row["id"])
        # 7а) Передачи между компьютерами: живут сутки (и недокачанные тоже).
        for row in self.q("SELECT id FROM transfers WHERE created<?", now - s.transfer_ttl_hours * 3600):
            self.delete_transfer(row["id"])
        # 7б) Посылки по ссылке/коду: срок вышел — удаляем.
        for row in self.q("SELECT id FROM shares WHERE expires<?", now):
            self.delete_share(row["id"])
        self.run("DELETE FROM share_sessions WHERE expires<?", now)
        self.run("DELETE FROM share_access WHERE expires<?", now)
        # 7) Страницы сканера, с которыми давно ничего не делали.
        for row in self.q("SELECT id FROM scan_pages WHERE created<?", now - s.tool_ttl_min * 60):
            self.remove_scan_page(row["id"])

    def delete_owner_tools(self, owner: str) -> None:
        for row in self.q("SELECT * FROM tool_results WHERE owner=?", owner):
            self.tool_path(row["id"]).unlink(missing_ok=True)
        self.run("DELETE FROM tool_results WHERE owner=?", owner)
        for row in self.q("SELECT id FROM scan_pages WHERE owner=?", owner):
            self.remove_scan_page(row["id"])


def preview(row: sqlite3.Row) -> str:
    if row["kind"] == "text":
        text = " ".join(row["text"].split())
        return text[:120] + ("…" if len(text) > 120 else "")
    if row["kind"] == "voice":
        return "🎤 Голосовое сообщение"
    mime = row["mime"] or ""
    icon = "🖼" if mime.startswith("image/") else "🎬" if mime.startswith("video/") else "📎"
    return f"{icon} {row['name']}"


class RateLimiter:
    """Простой ограничитель: не больше N действий за окно времени."""

    def __init__(self):
        self.hits: dict[str, deque] = defaultdict(deque)

    def hit(self, key: str, limit: int, window_sec: int) -> None:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > window_sec:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, "Слишком много запросов. Подожди немного и попробуй снова")
        q.append(now)

    def prune(self) -> None:
        now = time.monotonic()
        for key in [k for k, q in self.hits.items() if not q or now - q[-1] > 3600]:
            del self.hits[key]


def make_qr_svg(data: str) -> str:
    img = qrcode.make(
        data,
        image_factory=qrcode.image.svg.SvgPathImage,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    return img.to_string(encoding="unicode")


def device_label(user_agent: str) -> str:
    ua = user_agent or ""
    if "Windows" in ua:
        system = "Windows"
    elif "Macintosh" in ua:
        system = "Mac"
    elif "CrOS" in ua:
        system = "Chromebook"
    elif "Linux" in ua and "Android" not in ua:
        system = "Linux"
    else:
        system = "Компьютер"
    for marker, name in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                         ("Chrome/", "Chrome"), ("Safari/", "Safari")):
        if marker in ua:
            return f"{system} · {name}"
    return system


def clean_label(name: str) -> str:
    name = re.sub(r"[\x00-\x1f\x7f]", "", name or "").strip()
    if not name:
        raise HTTPException(400, "Название не может быть пустым")
    return name[:40]


def normalize_mime(content_type: str | None) -> str:
    mime = (content_type or "").split(";")[0].strip().lower()
    return mime if "/" in mime and mime != "application/octet-stream" else ""


def safe_filename(name: str | None) -> str:
    # Имя файла только для показа: на диске файл лежит под случайным id.
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:150] or "file"


def copy_limited(src, dest: Path, limit: int) -> int | None:
    """Копирует загруженный файл на диск. None — если файл больше лимита."""
    total = 0
    with dest.open("wb") as out:
        while chunk := src.read(MB):
            total += len(chunk)
            if total > limit:
                return None
            out.write(chunk)
    return total


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# --------------------------------------------------------------- приложение


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings)
    limiter = RateLimiter()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.open()

        async def cleanup_loop():
            while True:
                await asyncio.sleep(settings.cleanup_interval_sec)
                try:
                    await store.cleanup()
                    limiter.prune()
                except Exception as exc:  # фоновая задача не должна падать
                    print(f"cleanup error: {exc}")

        task = asyncio.create_task(cleanup_loop())
        yield
        task.cancel()
        await store.flush_push()
        store.close()

    app = FastAPI(title="PhoneDrop", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.state.settings = settings
    app.state.limiter = limiter

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        h = response.headers
        host = request.headers.get("host", "")
        csp = CSP + (f" wss://{host} ws://{host}" if HOST_RE.fullmatch(host) else "")
        path = request.url.path
        is_guest_file = path.startswith("/g/") and path.count("/") >= 3  # /g/<ключ>/<файл>
        owner_file = path.startswith("/api/shares/") and path.endswith("/download")
        if not path.startswith(("/f/", "/t/", "/s/", "/x/")) and not is_guest_file and not owner_file:  # для файлов политику ставят сами обработчики
            h.setdefault("Content-Security-Policy", csp)
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        h.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
        if path.startswith("/static/") or path in ("/sw.js", "/manifest.webmanifest"):
            h.setdefault("Cache-Control", "no-cache")  # всегда проверять свежую версию после деплоя
        else:
            # Ничего не оставлять в кэше браузера — важно на чужих рабочих компьютерах.
            h["Cache-Control"] = "no-store"
        return response

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # ------------------------------------------------------------- помощники

    def is_https(request: Request) -> bool:
        return request.url.scheme == "https" or settings.public_url.startswith("https://")

    def base_url(request: Request) -> str:
        return settings.public_url or str(request.base_url).rstrip("/")

    def check_origin(headers) -> None:
        # Защита от CSRF: запросы с чужих сайтов отклоняются.
        origin = headers.get("origin")
        if not origin:
            return
        allowed = {headers.get("host", "")}
        if settings.public_url:
            allowed.add(urlsplit(settings.public_url).netloc)
        if urlsplit(origin).netloc not in allowed:
            raise HTTPException(403, "Запрос с чужого сайта отклонён")

    def role_of(request: Request, only: str | None = None) -> str:
        check_origin(request.headers)
        role = request.headers.get(ROLE_HEADER)
        if role not in ROLES:
            raise HTTPException(400, "Нет заголовка X-PD-Role")
        if only and role != only:
            raise HTTPException(403, "Это действие недоступно")
        return role

    not_linked = HTTPException(401, "Нет подключения. Отсканируй QR-код на компьютере")

    def require_pc(request: Request, linked: bool = True) -> sqlite3.Row:
        role_of(request, "pc")
        dev = store.device_by_token(request.cookies.get(PC_COOKIE))
        if not dev or (linked and not dev["account_id"]):
            raise not_linked
        store.run("UPDATE devices SET last_seen=? WHERE id=?", time.time(), dev["id"])
        return dev

    def require_phone(request: Request) -> sqlite3.Row:
        role_of(request, "phone")
        acc = store.account_by_token(request.cookies.get(PHONE_COOKIE))
        if not acc:
            raise not_linked
        store.run("UPDATE accounts SET last_active=? WHERE id=?", time.time(), acc["id"])
        return acc

    def phone_chat(acc: sqlite3.Row, chat_id: str | None) -> sqlite3.Row:
        dev = store.device(chat_id) if chat_id else None
        if not dev or dev["account_id"] != acc["id"]:
            raise HTTPException(404, "Чат не найден — возможно, компьютер отключили")
        return dev

    def set_pc_cookie(response, request: Request, token: str, mode: str) -> None:
        # «Чужой» компьютер: cookie живёт, пока открыт браузер. «Свой»: REMEMBER_DAYS.
        response.set_cookie(
            PC_COOKIE, token,
            max_age=settings.remember_days * DAY if mode == "remember" else None,
            httponly=True, samesite="strict", secure=is_https(request), path="/",
        )

    def set_phone_cookie(response, request: Request, token: str) -> None:
        # SameSite=Lax нужен для меню «Поделиться» на Android.
        response.set_cookie(
            PHONE_COOKIE, token, max_age=PHONE_COOKIE_DAYS * DAY,
            httponly=True, samesite="lax", secure=is_https(request), path="/",
        )

    def common_info() -> dict:
        return {
            "google": settings.google_enabled,
            "max_upload_mb": settings.max_upload_mb,
            "file_ttl_days": settings.file_ttl_days,
            "vapid_key": store.vapid_public,
        }

    def pc_state(request: Request, dev: sqlite3.Row, pair: tuple[str, float] | None = None) -> dict:
        data = common_info()
        data.update(
            linked=bool(dev["account_id"]),
            chat_id=dev["id"],
            device={"label": dev["label"], "mode": dev["mode"]},
        )
        if dev["account_id"]:
            data["messages"] = store.messages(dev["id"])
            data["phone_online"] = store.phone_online(dev["account_id"])
        if pair:
            code, expires = pair
            url = f"{base_url(request)}/pair/{code}"
            data["pair"] = {"url": url, "qr_svg": make_qr_svg(url), "expires_in": int(expires - time.time())}
        return data

    async def read_form(request: Request, limit_mb: int | None = None):
        """Читает форму с файлами, обрывая загрузку сверх лимита."""
        limit_mb = limit_mb or settings.max_upload_mb
        limit = limit_mb * MB
        too_big = HTTPException(413, f"Слишком большой размер. Лимит {limit_mb} МБ за раз")
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) > limit:
                    raise too_big
            except ValueError:
                raise HTTPException(400, "Неверный заголовок Content-Length")
        received = 0
        receive = request.receive

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise too_big
            return message

        limited = Request(request.scope, limited_receive)
        return await limited.form(max_files=50, max_fields=20, max_part_size=MAX_TEXT_CHARS * 4 + 1024)

    def ensure_disk_space() -> None:
        if shutil.disk_usage(store.files_root).free < settings.min_free_disk_mb * MB:
            raise HTTPException(507, "На сервере заканчивается место, попробуй позже")

    async def add_messages(dev: sqlite3.Row, sender: str, texts: list[str], files: list[UploadFile],
                           voice: UploadFile | None, duration: str | None) -> list[dict]:
        rows: list[tuple] = []
        for text in texts:
            text = text.replace("\r\n", "\n").strip()
            if not text:
                continue
            if len(text) > MAX_TEXT_CHARS:
                raise HTTPException(413, f"Слишком длинный текст (максимум {MAX_TEXT_CHARS} символов)")
            rows.append((uuid.uuid4().hex, "text", text, None, 0, None, None))

        uploads = [(f, "file") for f in files if f.filename]
        if voice is not None:
            uploads.append((voice, "voice"))
        if uploads:
            ensure_disk_space()

        saved: list[tuple[str, int]] = []
        folder = store.files_root / dev["id"]
        used = store.one("SELECT used_bytes FROM devices WHERE id=?", dev["id"])["used_bytes"]
        try:
            for up, kind in uploads:
                mime = normalize_mime(up.content_type) or (
                    mimetypes.guess_type(up.filename or "")[0] or "application/octet-stream"
                )
                if kind == "voice" and not mime.startswith("audio/"):
                    raise HTTPException(400, "Голосовое сообщение должно быть аудиофайлом")
                folder.mkdir(parents=True, exist_ok=True)
                mid = uuid.uuid4().hex
                dest = folder / mid
                remaining = settings.chat_quota_mb * MB - used
                size = await run_in_threadpool(copy_limited, up.file, dest, max(remaining, 0))
                if size is None:
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413, f"В этом чате закончилось место ({settings.chat_quota_mb} МБ). Удали старые файлы"
                    )
                used += size
                saved.append((mid, size))
                if kind == "voice":
                    ext = mimetypes.guess_extension(mime) or ".webm"
                    try:
                        dur = round(min(max(float(duration or 0), 0.0), MAX_VOICE_SEC), 1)
                    except ValueError:
                        dur = 0.0
                    rows.append((mid, "voice", None, f"voice-{time.strftime('%H%M%S')}{ext}", size, mime, dur))
                else:
                    rows.append((mid, "file", None, safe_filename(up.filename), size, mime, None))
        except BaseException:
            # Если что-то пошло не так посреди загрузки — не оставляем «сирот» на диске.
            for mid, _ in saved:
                (folder / mid).unlink(missing_ok=True)
            raise

        now = time.time()
        for i, (mid, kind, text, name, size, mime, dur) in enumerate(rows):
            store.run(
                "INSERT INTO messages (id, device_id, sender, kind, created, text, name, size, mime, duration) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                mid, dev["id"], sender, kind, now + i / 1000, text, name, size, mime, dur,
            )
        store.run("UPDATE devices SET used_bytes=? WHERE id=?", used, dev["id"])
        if sender == "phone":
            store.run("UPDATE devices SET phone_read_at=? WHERE id=?", now + 1, dev["id"])

        result = [store.message_public(store.one("SELECT * FROM messages WHERE id=?", r[0])) for r in rows]
        for m in result:
            await store.to_chat(dev, {"type": "message", "chat_id": dev["id"], "message": m})
        if result:
            notify(dev, sender, store.one("SELECT * FROM messages WHERE id=?", rows[-1][0]), len(result))
        return result

    def notify(dev: sqlite3.Row, sender: str, last: sqlite3.Row, count: int) -> None:
        body = preview(last) if count == 1 else f"{preview(last)} и ещё {count - 1}"
        if sender == "phone":
            store.push(f"dev:{dev['id']}", {"title": "📱 Телефон", "body": body, "url": "/", "tag": dev["id"]})
        else:
            store.push(f"acc:{dev['account_id']}", {
                "title": f"💻 {dev['label']}", "body": body, "url": f"/chat?c={dev['id']}", "tag": dev["id"],
            })

    # ---------------------------------------------------------- конвертер

    def uploads_from_paths(items: list[tuple[Path, str, str]]) -> list[UploadFile]:
        """Готовые файлы с диска → «загрузки», чтобы положить их в чат обычным путём."""
        return [UploadFile(path.open("rb"), filename=name, headers=Headers({"content-type": mime}))
                for path, name, mime in items]

    async def converter_post(path: str, inputs: list[tuple[Path, str, str]], data: dict) -> httpx.Response:
        """Отправляет файлы конвертеру. Его ошибки превращаются в понятные сообщения."""
        handles = [p.open("rb") for p, _, _ in inputs]
        try:
            files = [("files", (name, fh, mime)) for fh, (_, name, mime) in zip(handles, inputs)]
            async with httpx.AsyncClient(base_url=settings.converter_url, transport=store.converter_transport,
                                         timeout=httpx.Timeout(300, connect=5)) as client:
                response = await client.post(path, data=data, files=files)
        except httpx.HTTPError:
            raise HTTPException(503, "Конвертер сейчас недоступен, попробуй через минуту")
        finally:
            for fh in handles:
                fh.close()
        if response.status_code == 422:
            try:
                detail = response.json().get("detail")
            except ValueError:
                detail = None
            raise HTTPException(422, detail if isinstance(detail, str) else "Не получилось конвертировать файл")
        if response.status_code != 200:
            raise HTTPException(502, "Конвертер не справился с этим файлом")
        return response

    async def run_converter(op: str, inputs: list[tuple[Path, str, str]], options: dict, out_dir: Path) -> list[Path]:
        """Отправляет файлы конвертеру и раскладывает результаты в out_dir (по порядку)."""
        response = await converter_post(f"/convert/{op}", inputs, options)
        out_dir.mkdir(parents=True, exist_ok=True)

        def unpack() -> list[Path]:
            outs = []
            with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
                names = sorted(zf.namelist())
                if len(names) > 200:
                    raise HTTPException(502, "Слишком много файлов в результате")
                for i, member in enumerate(names):
                    dest = out_dir / f"out-{i:03d}"  # своё имя — никаких путей из архива
                    with zf.open(member) as src, dest.open("wb") as out:
                        shutil.copyfileobj(src, out)
                    outs.append(dest)
            return outs

        try:
            return await run_in_threadpool(unpack)
        except zipfile.BadZipFile:
            raise HTTPException(502, "Конвертер вернул повреждённый ответ")

    def save_results(owner: str, outs: list[Path], names: list[tuple[str, str]]) -> list[dict]:
        results = []
        now = time.time()
        for i, (path, (name, mime)) in enumerate(zip(outs, names)):
            rid = uuid.uuid4().hex
            size = path.stat().st_size
            path.replace(store.tool_path(rid))
            store.run("INSERT INTO tool_results (id, owner, name, mime, size, created) VALUES (?,?,?,?,?,?)",
                      rid, owner, name, mime, size, now + i / 1000)
            results.append(store.tool_public(store.one("SELECT * FROM tool_results WHERE id=?", rid)))
        return results

    def tool_owner(request: Request) -> tuple[str, str, sqlite3.Row]:
        role = role_of(request)
        if role == "pc":
            dev = require_pc(request)
            return role, f"dev:{dev['id']}", dev
        acc = require_phone(request)
        return role, f"acc:{acc['id']}", acc

    def owner_from_cookies(request: Request) -> set[str]:
        owners = set()
        if pc := store.device_by_token(request.cookies.get(PC_COOKIE)):
            owners.add(f"dev:{pc['id']}")
        if acc := store.account_by_token(request.cookies.get(PHONE_COOKIE)):
            owners.add(f"acc:{acc['id']}")
        return owners

    def result_names(op: str, inputs: list[tuple[Path, str, str]], count: int, title: str | None) -> list[tuple[str, str]]:
        first = stem(inputs[0][1]) if inputs else "file"
        if op == "office-pdf":
            return [(f"{first}.pdf", "application/pdf")]
        if op == "images-pdf":
            name = safe_filename(title) if title else "Скан"
            return [(name if name.lower().endswith(".pdf") else f"{name}.pdf", "application/pdf")]
        if op == "merge-pdf":
            return [(f"{first} (объединённый).pdf", "application/pdf")]
        if op == "compress-pdf":
            return [(f"{first} (сжатый).pdf", "application/pdf")]
        if op == "pdf-images":
            return [(f"{first} — стр. {i + 1}.jpg", "image/jpeg") for i in range(count)]
        return [(f"{stem(inputs[i][1]) if i < len(inputs) else first}.jpg", "image/jpeg") for i in range(count)]

    def check_tool_inputs(op: str, inputs: list[tuple[Path, str, str]]) -> None:
        if not inputs:
            raise HTTPException(400, "Выбери файлы")
        if op == "office-pdf":
            if len(inputs) != 1 or file_ext(inputs[0][1]) not in OFFICE_EXTS:
                raise HTTPException(400, "Выбери один документ Word, Excel или PowerPoint")
        elif op in ("images-pdf", "images-jpg"):
            if not all(is_image(name, mime) for _, name, mime in inputs):
                raise HTTPException(400, "Здесь можно использовать только фото и картинки")
        elif op == "merge-pdf":
            if len(inputs) < 2 or not all(is_pdf(name, mime) for _, name, mime in inputs):
                raise HTTPException(400, "Выбери хотя бы два PDF")
        elif op in ("pdf-images", "compress-pdf"):
            if len(inputs) != 1 or not is_pdf(inputs[0][1], inputs[0][2]):
                raise HTTPException(400, "Выбери один PDF")

    # ------------------------------------------------------------ страницы

    def is_phone(user_agent: str) -> bool:
        ua = user_agent or ""
        return ("Android" in ua and "Mobile" in ua) or "iPhone" in ua

    @app.get("/", include_in_schema=False)
    async def desktop_page(request: Request, desktop: int = 0):
        # С телефона главная страница сразу ведёт в приложение для телефона.
        # Планшеты (без слова Mobile) остаются «компьютером». ?desktop=1 — открыть страницу компьютера вручную.
        if not desktop and is_phone(request.headers.get("user-agent", "")):
            return RedirectResponse("/chat", status_code=302)
        return FileResponse(STATIC_DIR / "desktop.html")

    @app.get("/chat", include_in_schema=False)
    async def phone_page():
        return FileResponse(STATIC_DIR / "phone.html")

    @app.get("/pair/{code}", include_in_schema=False)
    async def pair_page(code: str):
        # Код здесь НЕ тратится: его тратит скрипт страницы через POST.
        # Так сканеры QR и превью ссылок не могут «съесть» одноразовый код.
        return FileResponse(STATIC_DIR / "phone.html")

    @app.get("/manifest.webmanifest", include_in_schema=False)
    async def manifest():
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker():
        return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript")

    @app.get("/healthz")
    async def healthz():
        # Используется Docker'ом и CI/CD: жив ли сервис и какая версия запущена.
        store.one("SELECT 1")
        return {"status": "ok", "version": os.getenv("APP_VERSION", "dev")}

    # ------------------------------------------------------------ компьютер

    @app.post("/api/pc/session")
    async def pc_session(request: Request):
        role_of(request, "pc")
        token = request.cookies.get(PC_COOKIE)
        dev = store.device_by_token(token)
        if dev is None:
            limiter.hit(f"device:{client_ip(request)}", settings.devices_per_ip, 600)
            dev, token = store.create_device(device_label(request.headers.get("user-agent", "")))
        store.run("UPDATE devices SET last_seen=? WHERE id=?", time.time(), dev["id"])
        pair = None if dev["account_id"] else store.new_pair_code(dev["id"])
        response = JSONResponse(pc_state(request, dev, pair))
        set_pc_cookie(response, request, token, dev["mode"])  # для «своего» — продлеваем срок
        return response

    @app.post("/api/pc/pair")
    async def pc_new_pair(request: Request):
        dev = require_pc(request, linked=False)
        if dev["account_id"]:
            raise HTTPException(409, "Компьютер уже подключён")
        return {"pair": pc_state(request, dev, store.new_pair_code(dev["id"]))["pair"]}

    @app.post("/api/pc/relink")
    async def pc_relink(request: Request):
        """«Переподключить телефон»: QR-код для нового (переустановленного) телефона."""
        dev = require_pc(request)
        if dev["mode"] != "remember":
            raise HTTPException(403, "Переподключать телефон можно только через «Мой компьютер»")
        limiter.hit(f"relink:{dev['id']}", 10, 600)
        return {"pair": pc_state(request, dev, store.new_pair_code(dev["id"]))["pair"]}

    @app.post("/api/pc/mode")
    async def pc_mode(request: Request):
        dev = require_pc(request, linked=False)
        body = await request.json()
        mode = body.get("mode") if isinstance(body, dict) else None
        if mode not in MODES:
            raise HTTPException(400, "Неизвестный режим")
        store.run("UPDATE devices SET mode=? WHERE id=?", mode, dev["id"])
        dev = store.device(dev["id"])
        if dev["account_id"]:
            await store.send_ws(store.phone_sockets.get(dev["account_id"], set()),
                                {"type": "chats_changed", "chat_id": dev["id"]})
        response = JSONResponse({"mode": mode})
        set_pc_cookie(response, request, request.cookies.get(PC_COOKIE), mode)
        return response

    @app.post("/api/pc/rename")
    async def pc_rename(request: Request):
        # Название можно задать ещё до сканирования QR — оно сразу появится на телефоне.
        dev = require_pc(request, linked=False)
        body = await request.json()
        label = clean_label(body.get("name") if isinstance(body, dict) else "")
        store.run("UPDATE devices SET label=? WHERE id=?", label, dev["id"])
        if dev["account_id"]:
            await store.to_chat(dev, {"type": "renamed", "chat_id": dev["id"], "label": label})
        return {"label": label}

    @app.post("/api/pc/logout")
    async def pc_logout(request: Request):
        dev = require_pc(request, linked=False)
        await store.close_device(dev, "pc_closed")
        response = JSONResponse({"ok": True})
        response.delete_cookie(PC_COOKIE, path="/")
        return response

    @app.get("/api/state")
    async def pc_get_state(request: Request):
        return pc_state(request, require_pc(request))

    # -------------------------------------------------------------- телефон

    async def kick_old_phone(acc: sqlite3.Row, old: sqlite3.Row | None, old_subs: list) -> None:
        """Старый телефон аккаунта: закрываем его соединения и предупреждаем последним уведомлением."""
        for key in {acc["id"], old["id"] if old else None} - {None}:
            for ws in list(store.phone_sockets.pop(key, set())):
                try:
                    await ws.send_json({"type": "closed", "reason": "relinked"})
                    await ws.close(code=4000)
                except Exception:
                    pass
        for sub in old_subs:
            task = asyncio.create_task(store._push_one(sub, {
                "title": "PhoneDrop", "url": "/chat", "tag": "relinked",
                "body": "Твои чаты открыты на другом телефоне. Если это был не ты — войди снова и смени пароль Google."}))
            store.push_tasks.add(task)
            task.add_done_callback(store.push_tasks.discard)
        for d in store.q("SELECT * FROM devices WHERE account_id=?", acc["id"]):
            await store.presence(d)

    # ------------------------------------------------------- вход через Google
    # Стандарт OpenID Connect: «код авторизации» + PKCE + state + nonce.
    # Мы получаем от Google только адрес почты и постоянный номер аккаунта (sub). Пароль Google мы не видим.
    GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
    GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
    OAUTH_COOKIE = "pd_oauth"

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    def sign(payload: dict) -> str:
        body = b64url(json.dumps(payload, separators=(",", ":")).encode())
        return body + "." + store.keyed_hash(body)

    def unsign(value: str | None) -> dict | None:
        if not value or "." not in value:
            return None
        body, mac = value.rsplit(".", 1)
        if not hmac.compare_digest(mac, store.keyed_hash(body)):
            return None
        try:
            return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        except ValueError:
            return None

    def redirect_uri() -> str:
        return f"{settings.public_url}/auth/google/callback"

    def login_failed(role: str, text: str) -> RedirectResponse:
        target = "/chat" if role == "phone" else "/"
        return RedirectResponse(f"{target}?login_error={quote(text)}", status_code=303)

    @app.get("/auth/google", include_in_schema=False)
    async def google_start(request: Request, role: str = "phone"):
        if not settings.google_enabled:
            raise HTTPException(404, "Вход через Google не настроен")
        if role not in ROLES:
            raise HTTPException(400, "Неизвестная роль")
        limiter.hit(f"login:{client_ip(request)}", 30, 600)
        state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
        challenge = b64url(hashlib.sha256(verifier.encode()).digest())
        params = {
            "client_id": settings.google_client_id, "redirect_uri": redirect_uri(), "response_type": "code",
            "scope": "openid email", "state": state, "nonce": nonce, "prompt": "select_account",
            "code_challenge": challenge, "code_challenge_method": "S256",
        }
        response = RedirectResponse(GOOGLE_AUTH + "?" + "&".join(f"{k}={quote(v)}" for k, v in params.items()),
                                    status_code=303)
        response.set_cookie(OAUTH_COOKIE, sign({"s": state, "n": nonce, "v": verifier, "r": role, "t": time.time()}),
                            max_age=600, httponly=True, samesite="lax", secure=is_https(request), path="/auth")
        return response

    @app.get("/auth/google/callback", include_in_schema=False)
    async def google_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        saved = unsign(request.cookies.get(OAUTH_COOKIE))
        role = saved.get("r", "phone") if saved else "phone"
        if error:
            return login_failed(role, "Вход отменён")
        if not saved or not state or not hmac.compare_digest(saved.get("s", ""), state) or time.time() - saved.get("t", 0) > 600:
            return login_failed(role, "Вход устарел — попробуй ещё раз")
        try:
            async with httpx.AsyncClient(transport=store.google_transport, timeout=15) as client:
                r = await client.post(GOOGLE_TOKEN, data={
                    "code": code, "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret, "redirect_uri": redirect_uri(),
                    "grant_type": "authorization_code", "code_verifier": saved["v"],
                })
            id_token = r.json().get("id_token", "") if r.status_code == 200 else ""
            claims = json.loads(base64.urlsafe_b64decode(id_token.split(".")[1] + "==="))
        except Exception:
            return login_failed(role, "Google не ответил — попробуй ещё раз")
        # Токен пришёл напрямую от Google по HTTPS (OpenID Connect, п. 3.1.3.7) — проверяем поля.
        ok = (claims.get("iss") in ("https://accounts.google.com", "accounts.google.com")
              and claims.get("aud") == settings.google_client_id
              and claims.get("exp", 0) > time.time()
              and hmac.compare_digest(str(claims.get("nonce", "")), saved["n"])
              and claims.get("email_verified") is True and claims.get("sub"))
        if not ok:
            return login_failed(role, "Google вернул неверные данные — попробуй ещё раз")
        email = str(claims.get("email", "")).lower()
        if settings.allowed_emails and email not in settings.allowed_emails:
            return login_failed(role, f"Доступ закрыт: адреса {email} нет в списке разрешённых")
        sub = str(claims["sub"])
        account = store.one("SELECT * FROM accounts WHERE google_sub=?", sub)
        if role == "phone":
            current = store.account_by_token(request.cookies.get(PHONE_COOKIE))
            new_token = None
            if account is None and current is not None and not current["google_sub"]:
                # Первый вход с уже работающего телефона — просто привязываем Google к нему.
                store.run("UPDATE accounts SET google_sub=?, email=? WHERE id=?", sub, email, current["id"])
            elif account is None:
                account, new_token = store.create_account(sub, email)
            elif not current or current["id"] != account["id"]:
                account, new_token, old_subs = store.take_over_phone(account, current)
                await kick_old_phone(account, current, old_subs)
            response = RedirectResponse("/chat?login=ok", status_code=303)
            if new_token:
                set_phone_cookie(response, request, new_token)
        else:
            dev = store.device_by_token(request.cookies.get(PC_COOKIE))
            if not dev:
                return login_failed(role, "Обнови страницу и попробуй ещё раз")
            if account is None:
                account, _ = store.create_account(sub, email)  # ключ телефона появится, когда войдёшь на телефоне
            if dev["account_id"] and dev["account_id"] != account["id"]:
                return login_failed(role, "Этот компьютер уже подключён к другому аккаунту — сначала отключи его")
            if not dev["account_id"]:
                try:
                    dev = store.link_pc(dev, account)
                except HTTPException as exc:
                    return login_failed(role, exc.detail)
                await store.send_ws(store.phone_sockets.get(account["id"], set()),
                                    {"type": "chats_changed", "chat_id": dev["id"]})
            response = RedirectResponse("/?login=ok", status_code=303)
        response.delete_cookie(OAUTH_COOKIE, path="/auth")
        return response

    @app.post("/api/phone/logout")
    async def phone_logout(request: Request):
        acc = require_phone(request)
        if not acc["google_sub"]:
            raise HTTPException(409, "Сначала привяжи Google — иначе после выхода не сможешь вернуться к своим чатам")
        response = JSONResponse({"ok": True})
        response.delete_cookie(PHONE_COOKIE, path="/")
        return response

    @app.post("/api/pair/{code}")
    async def pair(code: str, request: Request):
        role_of(request, "phone")
        limiter.hit(f"pair:{client_ip(request)}", 30, 600)
        old = store.account_by_token(request.cookies.get(PHONE_COOKIE))
        dev, acc, new_token, old_subs = store.consume_pair_code(code, request.cookies.get(PHONE_COOKIE))
        relinked = old_subs is not None
        if relinked:
            await store.send_ws(store.pc_sockets.get(dev["id"], set()), {"type": "relinked"})
            await kick_old_phone(acc, old, old_subs)
        else:
            await store.send_ws(store.pc_sockets.get(dev["id"], set()), {"type": "linked"})
        await store.send_ws(store.phone_sockets.get(acc["id"], set()), {"type": "chats_changed", "chat_id": dev["id"]})
        response = JSONResponse({"chat_id": dev["id"], "relinked": relinked})
        if new_token:
            set_phone_cookie(response, request, new_token)
        return response

    @app.get("/api/login-info")
    async def login_info():
        return {"google": settings.google_enabled}

    @app.get("/api/phone/chats")
    async def phone_chats(request: Request):
        acc = require_phone(request)
        data = common_info()
        data["account"] = {"email": acc["email"], "google": bool(acc["google_sub"])}
        data["chats"] = store.phone_chats(acc["id"])
        return data

    @app.get("/api/chats/{chat_id}")
    async def phone_get_chat(chat_id: str, request: Request):
        dev = phone_chat(require_phone(request), chat_id)
        return {"chat": store.chat_summary(dev), "messages": store.messages(dev["id"])}

    @app.post("/api/chats/{chat_id}/read")
    async def phone_read(chat_id: str, request: Request):
        dev = phone_chat(require_phone(request), chat_id)
        store.run("UPDATE devices SET phone_read_at=? WHERE id=?", time.time(), dev["id"])
        return {"ok": True}

    @app.post("/api/chats/{chat_id}/rename")
    async def phone_rename(chat_id: str, request: Request):
        dev = phone_chat(require_phone(request), chat_id)
        body = await request.json()
        label = clean_label(body.get("name") if isinstance(body, dict) else "")
        store.run("UPDATE devices SET label=? WHERE id=?", label, dev["id"])
        await store.to_chat(dev, {"type": "renamed", "chat_id": dev["id"], "label": label})
        return {"label": label}

    @app.post("/api/chats/{chat_id}/reattach")
    async def phone_reattach_pc(chat_id: str, request: Request):
        acc = require_phone(request)
        dev = phone_chat(acc, chat_id)
        limiter.hit(f"pair:{client_ip(request)}", 30, 600)
        body = await request.json()
        code = body.get("code") if isinstance(body, dict) else None
        old_sockets = store.pc_sockets.pop(dev["id"], set())
        fresh, dev = store.reattach_pc(dev, code if isinstance(code, str) else "")
        # Старый браузер (если он ещё открыт) отключаем, новый — перезагружает переписку.
        for ws in list(old_sockets):
            try:
                await ws.send_json({"type": "closed", "reason": "moved"})
                await ws.close(code=4000)
            except Exception:
                pass
        for ws in list(store.pc_sockets.pop(fresh["id"], set())):
            try:
                await ws.send_json({"type": "closed", "reason": "reattached"})
                await ws.close(code=4000)
            except Exception:
                pass
        store.run("DELETE FROM push_subs WHERE owner=?", f"dev:{dev['id']}")  # уведомления — заново в новом браузере
        await store.presence(dev)
        return {"chat_id": dev["id"], "label": dev["label"]}

    @app.delete("/api/chats/{chat_id}")
    async def phone_remove_chat(chat_id: str, request: Request):
        dev = phone_chat(require_phone(request), chat_id)
        await store.close_device(dev, "phone_removed")
        return {"ok": True}

    # ------------------------------------------------------------ сообщения

    @app.post("/api/send")
    async def send(request: Request):
        role = role_of(request)
        if role == "pc":
            dev = require_pc(request)
            limiter.hit(f"send:{dev['id']}", settings.sends_per_min, 60)
        else:
            acc = require_phone(request)
            limiter.hit(f"send:{acc['id']}", settings.sends_per_min, 60)
        form = await read_form(request)
        try:
            if role == "phone":
                chat_id = form.get("chat_id")
                dev = phone_chat(acc, chat_id if isinstance(chat_id, str) else None)
            voice = form.get("voice")
            duration = form.get("duration")
            items = await add_messages(
                dev, role,
                [v for v in form.getlist("text") if isinstance(v, str)],
                [v for v in form.getlist("files") if isinstance(v, UploadFile)],
                voice if isinstance(voice, UploadFile) else None,
                duration if isinstance(duration, str) else None,
            )
        finally:
            await form.close()
        if not items:
            raise HTTPException(400, "Нечего отправлять")
        return {"messages": items}

    @app.delete("/api/messages/{mid}")
    async def delete_message(mid: str, request: Request):
        role = role_of(request)
        row = store.one("SELECT * FROM messages WHERE id=?", mid)
        dev = store.device(row["device_id"]) if row else None
        if role == "pc":
            me = require_pc(request)
            allowed = dev is not None and dev["id"] == me["id"]
        else:
            acc = require_phone(request)
            allowed = dev is not None and dev["account_id"] == acc["id"]
        if not allowed:
            raise HTTPException(404, "Сообщение не найдено")
        store.delete_message(row)
        await store.to_chat(dev, {"type": "deleted", "chat_id": dev["id"], "id": mid})
        return {"ok": True}

    @app.post("/share", include_in_schema=False)
    async def share_target(request: Request):
        # Сюда Android присылает то, чем поделились через меню «Поделиться».
        # Чужой сайт сюда отправить не сможет: cookie с SameSite=Lax не уходит с чужих форм.
        acc = store.account_by_token(request.cookies.get(PHONE_COOKIE))
        chats = store.phone_chats(acc["id"]) if acc else []
        if not chats:
            return RedirectResponse("/chat?share=nosession", status_code=303)
        # Отправляем на компьютер, который сейчас онлайн; если таких нет — в последний активный чат.
        target = next((c for c in chats if c["pc_online"]), chats[0])
        dev = store.device(target["id"])
        limiter.hit(f"send:{acc['id']}", settings.sends_per_min, 60)
        form = await read_form(request)
        try:
            parts: list[str] = []
            for key in ("title", "text", "url"):
                value = form.get(key)
                if isinstance(value, str) and value.strip() and value.strip() not in parts:
                    parts.append(value.strip())
            items = await add_messages(
                dev, "phone", ["\n".join(parts)] if parts else [],
                [v for v in form.getlist("files") if isinstance(v, UploadFile)], None, None,
            )
        finally:
            await form.close()
        return RedirectResponse(f"/chat?c={dev['id']}&shared={len(items)}", status_code=303)

    # ------------------------------------------------- передачи между компьютерами
    # Большой файл (до 10 ГБ) идёт с компьютера на компьютер через сервер частями по 8 МБ.
    # Оборвалась связь — загрузка продолжается с последней принятой части. Хранится сутки.

    async def write_chunk(path: Path, size: int, offset: int, request: Request) -> int:
        """Пишет одну часть (до TRANSFER_CHUNK_MB) в файл с нужного места. Возвращает, сколько всего получено."""
        if shutil.disk_usage(store.transfers_root).free < settings.min_free_disk_mb * MB:
            raise HTTPException(507, "На сервере заканчивается место, попробуй позже")
        limit = min(settings.transfer_chunk_mb * MB, size - offset)
        written = 0
        with path.open("r+b") as f:
            f.seek(offset)
            async for piece in request.stream():
                written += len(piece)
                if written > limit:
                    raise HTTPException(413, "Слишком большая часть файла")
                await run_in_threadpool(f.write, piece)
        return offset + written

    def check_space(account_id: str, size: int) -> None:
        if size > settings.transfer_max_mb * MB:
            raise HTTPException(413, f"Слишком большой файл. Максимум {settings.transfer_max_mb // 1024} ГБ")
        if store.account_used_bytes(account_id) + size > settings.transfer_quota_mb * MB:
            raise HTTPException(507, f"Лимит — {settings.transfer_quota_mb // 1024} ГБ файлов одновременно. "
                                     "Удали старые передачи или подожди, пока они удалятся сами")
        if shutil.disk_usage(store.transfers_root).free - store.reserved_bytes() - size < settings.min_free_disk_mb * MB:
            raise HTTPException(507, "На сервере сейчас не хватает места для такого файла. Попробуй позже")

    def my_transfer(tid: str, dev: sqlite3.Row) -> sqlite3.Row:
        row = store.one("SELECT * FROM transfers WHERE id=? AND account_id=?", tid, dev["account_id"])
        if not row or dev["id"] not in (row["from_dev"], row["to_dev"]):
            raise HTTPException(404, "Передача не найдена — возможно, прошли сутки и файл удалён")
        return row

    async def transfers_changed(row: sqlite3.Row) -> None:
        for dev_id in {row["from_dev"], row["to_dev"]} - {None}:
            await store.send_ws(store.pc_sockets.get(dev_id, set()), {"type": "transfers_changed"})

    @app.get("/api/pc/devices")
    async def pc_devices(request: Request):
        """Другие мои компьютеры — куда можно отправить файл."""
        me = require_pc(request)
        rows = store.q("SELECT * FROM devices WHERE account_id=? AND id!=?", me["account_id"], me["id"])
        devices = [{"id": d["id"], "label": d["label"], "mode": d["mode"], "online": store.pc_online(d["id"])}
                   for d in rows]
        devices.sort(key=lambda d: (not d["online"], d["label"].lower()))
        return {"devices": devices}

    @app.get("/api/transfers")
    async def list_transfers(request: Request):
        me = require_pc(request)
        rows = store.q("SELECT * FROM transfers WHERE account_id=? AND (from_dev=? OR to_dev=?) ORDER BY created DESC",
                       me["account_id"], me["id"], me["id"])
        items = [store.transfer_public(r, me["id"]) for r in rows]
        used = store.account_used_bytes(me["account_id"])
        return {
            "incoming": [t for t in items if t["direction"] == "in" and t["done"]],
            "outgoing": [t for t in items if t["direction"] == "out"],
            "max_mb": settings.transfer_max_mb, "quota_mb": settings.transfer_quota_mb, "used": used,
            "ttl_hours": settings.transfer_ttl_hours, "chunk_mb": settings.transfer_chunk_mb,
        }

    @app.post("/api/transfers")
    async def create_transfer(request: Request):
        me = require_pc(request)
        limiter.hit(f"transfer:{me['account_id']}", 60, 600)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "Неверный запрос")
        name = safe_filename(body.get("name") if isinstance(body.get("name"), str) else "")
        size = body.get("size")
        if not isinstance(size, int) or size <= 0:
            raise HTTPException(400, "Пустой файл отправлять незачем")
        target = store.device(body.get("to")) if isinstance(body.get("to"), str) else None
        if not target or target["account_id"] != me["account_id"] or target["id"] == me["id"]:
            raise HTTPException(404, "Компьютер-получатель не найден")
        check_space(me["account_id"], size)
        mime = body.get("mime") if isinstance(body.get("mime"), str) else ""
        tid = uuid.uuid4().hex
        store.run("INSERT INTO transfers (id, account_id, from_dev, from_label, to_dev, name, size, mime, created) "
                  "VALUES (?,?,?,?,?,?,?,?,?)", tid, me["account_id"], me["id"], me["label"], target["id"],
                  name, size, normalize_mime(mime) or mimetypes.guess_type(name)[0] or "application/octet-stream",
                  time.time())
        store.transfer_path(tid).touch()
        return store.transfer_public(store.one("SELECT * FROM transfers WHERE id=?", tid), me["id"])

    @app.put("/api/transfers/{tid}/data")
    async def upload_transfer_chunk(tid: str, request: Request, offset: int = -1):
        """Одна часть файла. Сервер принимает части строго по порядку: offset должен
        совпасть с тем, сколько уже получено, — иначе ответ 409 с правильным местом."""
        me = require_pc(request)
        async with store.transfer_locks[tid]:
            row = my_transfer(tid, me)
            if row["from_dev"] != me["id"]:
                raise HTTPException(403, "Догружать файл может только отправитель")
            if row["done"]:
                return {"received": row["received"], "done": True}
            if offset != row["received"]:
                return JSONResponse({"detail": "Не то место в файле", "received": row["received"]}, status_code=409)
            received = await write_chunk(store.transfer_path(tid), row["size"], offset, request)
            done = time.time() if received == row["size"] else None
            store.run("UPDATE transfers SET received=?, done=? WHERE id=?", received, done, tid)
        if done:
            row = store.one("SELECT * FROM transfers WHERE id=?", tid)
            await transfers_changed(row)
            store.push(f"dev:{row['to_dev']}", {
                "title": f"📦 Файл с «{row['from_label']}»",
                "body": f"{row['name']} · {round(row['size'] / MB, 1)} МБ — скачай в течение {settings.transfer_ttl_hours} ч",
                "url": "/", "tag": f"transfer-{tid}",
            })
        return {"received": received, "done": bool(done)}

    @app.delete("/api/transfers/{tid}")
    async def delete_transfer(tid: str, request: Request):
        me = require_pc(request)
        row = my_transfer(tid, me)
        store.delete_transfer(tid)
        await transfers_changed(row)
        return {"ok": True}

    @app.get("/x/{tid}")
    async def download_transfer(tid: str, request: Request):
        # Скачивание поддерживает «докачку» (Range): Chrome продолжит прерванную загрузку.
        dev = store.device_by_token(request.cookies.get(PC_COOKIE))
        row = store.one("SELECT * FROM transfers WHERE id=?", tid)
        if not dev or not row or row["account_id"] != dev["account_id"] or dev["id"] not in (row["from_dev"], row["to_dev"]):
            raise HTTPException(404, "Файл не найден — возможно, прошли сутки и он удалён")
        if not row["done"]:
            raise HTTPException(409, "Файл ещё загружается")
        return FileResponse(store.transfer_path(tid), media_type="application/octet-stream", filename=row["name"],
                            content_disposition_type="attachment", headers={"Content-Security-Policy": "sandbox"})

    # ------------------------------------------------- посылки «другому человеку»
    # Ссылка и 9-значный код. Получатель открывает ссылку или вводит код на /get —
    # без регистрации. На сервере хранятся только «отпечатки» ссылки, кода и пароля.
    SHARE_HOURS = (1, 6, 24)
    GUEST_COOKIE = "pd_guest"

    def account_of(role: str, who: sqlite3.Row) -> str:
        return who["account_id"] if role == "pc" else who["id"]

    def new_share_secrets() -> tuple[str, str]:
        token = secrets.token_urlsafe(24)
        while True:  # 9 цифр; совпадение с действующим кодом почти невозможно, но проверяем
            code = f"{secrets.randbelow(10**9):09d}"
            if not store.one("SELECT 1 FROM shares WHERE code_hash=?", store.keyed_hash(code)):
                return token, code

    def share_links(request: Request, token: str, code: str) -> dict:
        return {"link": f"{base_url(request)}/g/{token}", "code": f"{code[:3]} {code[3:6]} {code[6:]}",
                "get_url": f"{base_url(request)}/get"}

    def hash_password(password: str, salt: bytes) -> str:
        return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()

    def owner_share(sid: str, request: Request) -> tuple[sqlite3.Row, str, str]:
        role, owner, who = tool_owner(request)
        row = store.one("SELECT * FROM shares WHERE id=? AND account_id=?", sid, account_of(role, who))
        if not row:
            raise HTTPException(404, "Посылка не найдена — возможно, срок вышел")
        return row, role, owner

    def share_owner_public(row: sqlite3.Row) -> dict:
        return {"id": row["id"], "owner_label": row["owner_label"], "created": row["created"],
                "expires": row["expires"], "once": bool(row["once"]), "notify": bool(row["notify"]),
                "has_password": bool(row["pw_hash"]), "files": store.share_files(row["id"]),
                "kind": row["kind"], "max_bytes": row["max_bytes"]}

    async def shares_changed(row: sqlite3.Row) -> None:
        kind, _, key = row["owner"].partition(":")
        sockets = store.pc_sockets.get(key, set()) if kind == "dev" else store.phone_sockets.get(key, set())
        await store.send_ws(sockets, {"type": "shares_changed"})

    @app.get("/api/shares")
    async def list_shares(request: Request):
        role, _, who = tool_owner(request)
        rows = store.q("SELECT * FROM shares WHERE account_id=? ORDER BY created DESC", account_of(role, who))
        return {"shares": [share_owner_public(r) for r in rows], "hours": SHARE_HOURS,
                "max_mb": settings.transfer_max_mb, "chunk_mb": settings.transfer_chunk_mb,
                "quota_mb": settings.transfer_quota_mb, "used": store.account_used_bytes(account_of(role, who))}

    @app.post("/api/shares")
    async def create_share(request: Request):
        role, owner, who = tool_owner(request)
        limiter.hit(f"share:{owner}", 30, 600)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "Неверный запрос")
        hours = body.get("hours") if body.get("hours") in SHARE_HOURS else 24
        password = body.get("password") if isinstance(body.get("password"), str) else ""
        password = password.strip()
        if password and not (4 <= len(password) <= 64):
            raise HTTPException(400, "Пароль — от 4 до 64 символов")
        salt = secrets.token_bytes(16) if password else None
        # Как отправитель подпишется для получателя («Файлы от Роман»). По умолчанию — имя компьютера.
        raw_name = body.get("name") if isinstance(body.get("name"), str) else ""
        sender = re.sub(r"[\x00-\x1f\x7f]", "", raw_name).strip()[:40] or (who["label"] if role == "pc" else "PhoneDrop")
        token, code = new_share_secrets()
        sid = uuid.uuid4().hex
        now = time.time()
        # kind="request" — «Попросить файлы»: по коду люди ЗАГРУЖАЮТ файлы тебе (до max_mb), скачать ничего не могут.
        kind = "request" if body.get("kind") == "request" else "send"
        max_mb = body.get("max_mb") if isinstance(body.get("max_mb"), int) else settings.transfer_max_mb
        max_bytes = min(max(max_mb, 1), settings.transfer_max_mb) * MB if kind == "request" else 0
        if kind == "request":
            password, salt = "", None
        store.run("INSERT INTO shares (id, account_id, owner, owner_label, token_hash, code_hash, pw_salt, pw_hash, "
                  "once, notify, created, expires, kind, max_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  sid, account_of(role, who), owner, sender,
                  store.keyed_hash(token), store.keyed_hash(code), salt.hex() if salt else None,
                  hash_password(password, salt) if password else None,
                  int(bool(body.get("once"))) if kind == "send" else 0, int(body.get("notify", True) is not False),
                  now, now + hours * 3600, kind, max_bytes)
        row = store.one("SELECT * FROM shares WHERE id=?", sid)
        return {"share": share_owner_public(row), **share_links(request, token, code)}

    @app.post("/api/shares/{sid}/rotate")
    async def rotate_share(sid: str, request: Request):
        """Новая ссылка и код (старые перестают работать). Нужна, если ссылку потеряли или она утекла."""
        row, _, _ = owner_share(sid, request)
        token, code = new_share_secrets()
        store.run("UPDATE shares SET token_hash=?, code_hash=? WHERE id=?", store.keyed_hash(token), store.keyed_hash(code), sid)
        store.run("DELETE FROM share_sessions WHERE share_id=?", sid)
        store.run("DELETE FROM share_access WHERE share_id=?", sid)  # старые ссылки «по коду» тоже гаснут
        return {"share": share_owner_public(store.one("SELECT * FROM shares WHERE id=?", sid)),
                **share_links(request, token, code)}

    @app.delete("/api/shares/{sid}")
    async def delete_share(sid: str, request: Request):
        owner_share(sid, request)
        store.delete_share(sid)
        return {"ok": True}

    @app.post("/api/shares/{sid}/files")
    async def add_share_file(sid: str, request: Request):
        row, _, _ = owner_share(sid, request)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "Неверный запрос")
        size = body.get("size")
        if not isinstance(size, int) or size <= 0:
            raise HTTPException(400, "Пустой файл отправлять незачем")
        if store.one("SELECT COUNT(*) AS n FROM share_files WHERE share_id=?", sid)["n"] >= 200:
            raise HTTPException(400, "В одной посылке — не больше 200 файлов")
        check_space(row["account_id"], size)
        name = safe_filename(body.get("name") if isinstance(body.get("name"), str) else "")
        mime = body.get("mime") if isinstance(body.get("mime"), str) else ""
        fid = uuid.uuid4().hex
        store.run("INSERT INTO share_files (id, share_id, name, size, mime, created) VALUES (?,?,?,?,?,?)",
                  fid, sid, name, size, normalize_mime(mime) or mimetypes.guess_type(name)[0] or "application/octet-stream",
                  time.time())
        store.share_path(fid).touch()
        return {"id": fid, "name": name, "size": size, "received": 0, "done": False, "downloads": 0}

    @app.put("/api/shares/{sid}/files/{fid}/data")
    async def upload_share_chunk(sid: str, fid: str, request: Request, offset: int = -1):
        owner_share(sid, request)
        async with store.transfer_locks[fid]:
            f = store.one("SELECT * FROM share_files WHERE id=? AND share_id=?", fid, sid)
            if not f:
                raise HTTPException(404, "Файл не найден")
            if f["done"]:
                return {"received": f["received"], "done": True}
            if offset != f["received"]:
                return JSONResponse({"detail": "Не то место в файле", "received": f["received"]}, status_code=409)
            received = await write_chunk(store.share_path(fid), f["size"], offset, request)
            done = time.time() if received == f["size"] else None
            store.run("UPDATE share_files SET received=?, done=? WHERE id=?", received, done, fid)
        return {"received": received, "done": bool(done)}

    @app.delete("/api/shares/{sid}/files/{fid}")
    async def delete_share_file(sid: str, fid: str, request: Request):
        owner_share(sid, request)
        if not store.one("SELECT 1 FROM share_files WHERE id=? AND share_id=?", fid, sid):
            raise HTTPException(404, "Файл не найден")
        store.delete_share_file(fid)
        return {"ok": True}

    # ---------- получатель (без регистрации)

    @app.get("/get", include_in_schema=False)
    async def guest_code_page():
        return FileResponse(STATIC_DIR / "guest.html")

    @app.get("/g/{token}", include_in_schema=False)
    async def guest_share_page(token: str):
        return FileResponse(STATIC_DIR / "guest.html")

    def share_by_ref(ref: str) -> sqlite3.Row:
        """ref — ключ из ссылки /g/<ключ>. Ссылка, открытая по коду, выглядит как /g/c.<ключ>."""
        row = None
        if ref.startswith("c."):
            acc = store.one("SELECT share_id FROM share_access WHERE key_hash=? AND expires>?", token_hash(ref[2:]), time.time())
            row = store.one("SELECT * FROM shares WHERE id=?", acc["share_id"]) if acc else None
        elif ref:
            row = store.one("SELECT * FROM shares WHERE token_hash=?", store.keyed_hash(ref))
        if not row or row["expires"] < time.time():
            raise HTTPException(404, "Посылка не найдена: ссылка или код неверные, или срок хранения закончился")
        return row

    def guest_allowed(row: sqlite3.Row, request: Request) -> bool:
        if not row["pw_hash"]:
            return True
        key = request.cookies.get(GUEST_COOKIE)
        return bool(key and store.one("SELECT 1 FROM share_sessions WHERE key_hash=? AND share_id=? AND expires>?",
                                      token_hash(key), row["id"], time.time()))

    @app.post("/api/get/code")
    async def guest_by_code(request: Request):
        check_origin(request.headers)
        # Защита от подбора: 10 попыток за 10 минут с одного адреса и общий «предохранитель» на всех.
        limiter.hit(f"code:{client_ip(request)}", 10, 600)
        limiter.hit("code:all", 600, 600)
        body = await request.json()
        raw = body.get("code") if isinstance(body, dict) and isinstance(body.get("code"), str) else ""
        code = re.sub(r"\D", "", raw)
        row = store.one("SELECT * FROM shares WHERE code_hash=?", store.keyed_hash(code)) if len(code) == 9 else None
        if not row or row["expires"] < time.time():
            raise HTTPException(404, "Код не подходит или срок посылки закончился. Проверь цифры")
        # Код подошёл — выдаём личную ссылку получателя (живёт, пока жива посылка).
        key = secrets.token_urlsafe(24)
        store.run("INSERT INTO share_access (key_hash, share_id, expires) VALUES (?,?,?)",
                  token_hash(key), row["id"], row["expires"])
        return {"ref": f"c.{key}"}

    @app.post("/api/g/{ref}/unlock")
    async def guest_unlock(ref: str, request: Request):
        check_origin(request.headers)
        row = share_by_ref(ref)
        limiter.hit(f"pw:{client_ip(request)}:{row['id']}", 5, 900)  # 5 попыток пароля за 15 минут
        body = await request.json()
        password = body.get("password") if isinstance(body, dict) and isinstance(body.get("password"), str) else ""
        if not row["pw_hash"]:
            return {"ok": True}
        if not hmac.compare_digest(hash_password(password.strip(), bytes.fromhex(row["pw_salt"])), row["pw_hash"]):
            raise HTTPException(403, "Неверный пароль")
        key = secrets.token_urlsafe(32)
        store.run("INSERT INTO share_sessions (key_hash, share_id, expires) VALUES (?,?,?)",
                  token_hash(key), row["id"], row["expires"])
        response = JSONResponse({"ok": True})
        response.set_cookie(GUEST_COOKIE, key, max_age=max(60, int(row["expires"] - time.time())),
                            httponly=True, samesite="lax", secure=is_https(request), path="/")
        return response

    @app.get("/api/g/{ref}")
    async def guest_share(ref: str, request: Request):
        row = share_by_ref(ref)
        if row["kind"] == "request":
            # Отправителю не показываем, что уже лежит в «ящике», — только сколько места осталось.
            used = store.one("SELECT COALESCE(SUM(size), 0) AS n FROM share_files WHERE share_id=?", row["id"])["n"]
            return {"kind": "request", "owner_label": row["owner_label"], "expires": row["expires"],
                    "max_bytes": row["max_bytes"], "left_bytes": max(0, row["max_bytes"] - used),
                    "chunk_mb": settings.transfer_chunk_mb}
        if not guest_allowed(row, request):
            return JSONResponse({"password": True, "owner_label": row["owner_label"]}, status_code=401)
        files = store.share_files(row["id"])
        return {"owner_label": row["owner_label"], "expires": row["expires"], "once": bool(row["once"]),
                "files": [{"id": f["id"], "name": f["name"], "size": f["size"], "url": f"/g/{ref}/{f['id']}"}
                          for f in files if f["done"]],
                "uploading": [{"name": f["name"], "size": f["size"], "received": f["received"]}
                              for f in files if not f["done"]]}

    # ---------- «Попросить файлы»: гость загружает файлы владельцу

    def request_share(ref: str, request: Request) -> sqlite3.Row:
        check_origin(request.headers)
        row = share_by_ref(ref)
        if row["kind"] != "request":
            raise HTTPException(403, "По этой ссылке можно только скачивать")
        return row

    @app.post("/api/g/{ref}/files")
    async def guest_add_file(ref: str, request: Request):
        row = request_share(ref, request)
        limiter.hit(f"guest-up:{client_ip(request)}", 100, 600)
        body = await request.json()
        size = body.get("size") if isinstance(body, dict) else None
        if not isinstance(size, int) or size <= 0:
            raise HTTPException(400, "Пустой файл отправлять незачем")
        used = store.one("SELECT COALESCE(SUM(size), 0) AS n FROM share_files WHERE share_id=?", row["id"])["n"]
        if used + size > row["max_bytes"]:
            raise HTTPException(413, f"Не помещается: осталось {round(max(0, row['max_bytes'] - used) / MB)} МБ из "
                                     f"{round(row['max_bytes'] / MB)} МБ, которые разрешил получатель")
        if store.one("SELECT COUNT(*) AS n FROM share_files WHERE share_id=?", row["id"])["n"] >= 200:
            raise HTTPException(400, "Слишком много файлов — не больше 200")
        check_space(row["account_id"], size)
        name = safe_filename(body.get("name") if isinstance(body.get("name"), str) else "")
        fid = uuid.uuid4().hex
        store.run("INSERT INTO share_files (id, share_id, name, size, mime, created) VALUES (?,?,?,?,?,?)",
                  fid, row["id"], name, size, mimetypes.guess_type(name)[0] or "application/octet-stream", time.time())
        store.share_path(fid).touch()
        return {"id": fid, "received": 0, "size": size}

    @app.get("/api/g/{ref}/files/{fid}")
    async def guest_file_status(ref: str, fid: str, request: Request):
        row = request_share(ref, request)
        f = store.one("SELECT * FROM share_files WHERE id=? AND share_id=?", fid, row["id"])
        if not f:
            raise HTTPException(404, "Файл не найден")
        return {"received": f["received"], "done": bool(f["done"])}

    @app.put("/api/g/{ref}/files/{fid}/data")
    async def guest_upload_chunk(ref: str, fid: str, request: Request, offset: int = -1):
        row = request_share(ref, request)
        async with store.transfer_locks[fid]:
            f = store.one("SELECT * FROM share_files WHERE id=? AND share_id=?", fid, row["id"])
            if not f:
                raise HTTPException(404, "Файл не найден")
            if f["done"]:
                return {"received": f["received"], "done": True}
            if offset != f["received"]:
                return JSONResponse({"detail": "Не то место в файле", "received": f["received"]}, status_code=409)
            received = await write_chunk(store.share_path(fid), f["size"], offset, request)
            done = time.time() if received == f["size"] else None
            store.run("UPDATE share_files SET received=?, done=? WHERE id=?", received, done, fid)
        if done:
            if row["notify"]:
                store.push(row["owner"], {"title": "📥 Тебе прислали файл", "body": f"{f['name']} · {round(f['size'] / MB, 1)} МБ",
                                          "url": "/" if row["owner"].startswith("dev:") else "/chat", "tag": f"req-{fid}"})
            await shares_changed(row)
        return {"received": received, "done": bool(done)}

    @app.get("/api/shares/{sid}/files/{fid}/download")
    async def owner_download(sid: str, fid: str, request: Request):
        """Владелец скачивает то, что ему прислали (или то, что сам выложил). С докачкой."""
        owners = owner_from_cookies(request)
        accounts = set()
        for o in owners:
            kind, _, key = o.partition(":")
            row = store.device(key) if kind == "dev" else store.one("SELECT * FROM accounts WHERE id=?", key)
            if row:
                accounts.add(row["account_id"] if kind == "dev" else row["id"])
        share = store.one("SELECT * FROM shares WHERE id=?", sid)
        f = store.one("SELECT * FROM share_files WHERE id=? AND share_id=? AND done IS NOT NULL", fid, sid)
        if not share or share["account_id"] not in accounts or not f:
            raise HTTPException(404, "Файл не найден — возможно, срок вышел")
        return FileResponse(store.share_path(fid), media_type="application/octet-stream", filename=f["name"],
                            content_disposition_type="attachment", headers={"Content-Security-Policy": "sandbox"})

    @app.get("/g/{ref}/{fid}")
    async def guest_download(ref: str, fid: str, request: Request):
        row = share_by_ref(ref)
        if row["kind"] == "request":
            raise HTTPException(404, "Файл не найден")  # из «ящика» гость ничего скачать не может
        if not guest_allowed(row, request):
            raise HTTPException(403, "Сначала введи пароль")
        f = store.one("SELECT * FROM share_files WHERE id=? AND share_id=? AND done IS NOT NULL", fid, row["id"])
        if not f:
            raise HTTPException(404, "Файл не найден — возможно, его уже скачали и он удалён")
        path = store.share_path(fid)
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        headers = {
            "Content-Disposition": f"attachment; filename*=utf-8''{quote(f['name'])}",
            "Content-Security-Policy": "sandbox",
        }
        # «Удалить после скачивания» — без докачки: файл исчезает сразу после полной загрузки.
        if not row["once"]:
            headers["Accept-Ranges"] = "bytes"
            rng = request.headers.get("range")
            if rng:
                m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
                if not m or (not m.group(1) and not m.group(2)):
                    return PlainTextResponse("Неверный Range", 416, headers={"Content-Range": f"bytes */{size}"})
                if m.group(1):
                    start = int(m.group(1))
                    end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    return PlainTextResponse("Неверный Range", 416, headers={"Content-Range": f"bytes */{size}"})
                status = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)
        sid, owner, name, once, notify = row["id"], row["owner"], f["name"], row["once"], row["notify"]

        async def body():
            remaining = end - start + 1
            with path.open("rb") as fh:
                fh.seek(start)
                while remaining > 0:
                    piece = await run_in_threadpool(fh.read, min(MB, remaining))
                    if not piece:
                        break
                    remaining -= len(piece)
                    yield piece
            if end == size - 1 and remaining == 0:  # дошли до конца файла — считаем «скачали»
                store.run("UPDATE share_files SET downloads=downloads+1 WHERE id=?", fid)
                if notify:
                    store.push(owner, {"title": "📥 Файл скачали", "body": f"{name} — по твоей ссылке",
                                       "url": "/" if owner.startswith("dev:") else "/chat", "tag": f"share-{fid}"})
                if once:
                    store.delete_share_file(fid)
                    if not store.one("SELECT 1 FROM share_files WHERE share_id=?", sid):
                        store.delete_share(sid)
                current = store.one("SELECT * FROM shares WHERE id=?", sid)
                await shares_changed(current or row)

        return StreamingResponse(body(), status_code=status, media_type="application/octet-stream", headers=headers)

    @app.get("/f/{mid}")
    async def get_file(mid: str, request: Request, dl: int = 0):
        # Файл отдаётся только участникам того чата, которому он принадлежит.
        row = store.one("SELECT * FROM messages WHERE id=? AND kind!='text'", mid)
        dev = store.device(row["device_id"]) if row else None
        pc = store.device_by_token(request.cookies.get(PC_COOKIE))
        acc = store.account_by_token(request.cookies.get(PHONE_COOKIE))
        allowed = dev is not None and (
            (pc is not None and pc["id"] == dev["id"]) or (acc is not None and acc["id"] == dev["account_id"])
        )
        if not allowed:
            raise HTTPException(404, "Файл не найден")
        if row["expired"]:
            raise HTTPException(410, f"Файл удалён: он хранился {settings.file_ttl_days} дней")
        mime = row["mime"] or "application/octet-stream"
        inline_ok = viewable(mime) and not dl
        if not viewable(mime):
            mime = "application/octet-stream"
        headers = {}
        if (policy := file_csp(mime)) is not None:
            headers["Content-Security-Policy"] = policy
        return FileResponse(
            store.file_path(dev["id"], row["id"]),
            media_type=mime,
            filename=row["name"],
            content_disposition_type="inline" if inline_ok else "attachment",
            headers=headers,
        )

    @app.get("/f/{mid}/preview")
    async def preview_file(mid: str, request: Request):
        """Word/Excel/PowerPoint: показываем как PDF прямо в браузере (без скачивания)."""
        row = store.one("SELECT * FROM messages WHERE id=? AND kind='file'", mid)
        dev = store.device(row["device_id"]) if row else None
        allowed = dev is not None and (f"dev:{dev['id']}" in owner_from_cookies(request) or
                                       f"acc:{dev['account_id']}" in owner_from_cookies(request))
        if not allowed or convert_to(row["name"], row["mime"]) != "pdf":
            return PlainTextResponse("Файл не найден", 404)
        if row["expired"]:
            return PlainTextResponse(f"Файл удалён: он хранился {settings.file_ttl_days} дней", 410)
        cached = store.preview_path(dev["id"], row["id"])
        async with store.preview_locks[mid]:  # два одновременных открытия — одна конвертация
            if not cached.exists():
                limiter.hit(f"tool:{dev['id']}", settings.tools_per_min, 60)
                work = store.tmp_root / uuid.uuid4().hex
                try:
                    (out,) = await run_converter(
                        "office-pdf", [(store.file_path(dev["id"], row["id"]), row["name"], row["mime"])], {}, work)
                    out.replace(cached)
                except HTTPException as exc:
                    return PlainTextResponse(f"Не получилось показать документ: {exc.detail}", exc.status_code)
                finally:
                    shutil.rmtree(work, ignore_errors=True)
        store.preview_locks.pop(mid, None)
        return FileResponse(cached, media_type="application/pdf", filename=f"{stem(row['name'])}.pdf",
                            content_disposition_type="inline")

    @app.post("/api/messages/{mid}/convert")
    async def convert_message(mid: str, request: Request):
        """Кнопка «В PDF» / «В JPG» у файла в чате: результат появляется в чате новым файлом."""
        role = role_of(request)
        row = store.one("SELECT * FROM messages WHERE id=? AND kind='file'", mid)
        dev = store.device(row["device_id"]) if row else None
        if role == "pc":
            allowed = dev is not None and dev["id"] == require_pc(request)["id"]
        else:
            allowed = dev is not None and dev["account_id"] == require_phone(request)["id"]
        if not allowed:
            raise HTTPException(404, "Файл не найден")
        if row["expired"]:
            raise HTTPException(410, "Файл уже удалён")
        target = convert_to(row["name"], row["mime"])
        if target is None:
            raise HTTPException(400, "Этот файл нельзя конвертировать")
        limiter.hit(f"tool:{dev['id']}", settings.tools_per_min, 60)
        source = [(store.file_path(dev["id"], row["id"]), row["name"], row["mime"])]
        work = store.tmp_root / uuid.uuid4().hex
        try:
            if target == "pdf":
                (out,) = await run_converter("office-pdf", source, {}, work)
                result = [(out, f"{stem(row['name'])}.pdf", "application/pdf")]
            else:
                (out,) = await run_converter("images-jpg", source, {"preset": "original"}, work)
                result = [(out, f"{stem(row['name'])}.jpg", "image/jpeg")]
            uploads = uploads_from_paths(result)
            try:
                items = await add_messages(dev, role, [], uploads, None, None)
            finally:
                for up in uploads:
                    up.file.close()
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return {"messages": items}

    # ---------------------------------------------------------- инструменты

    # ------------------------------------------------------------ сканер 2.0
    # Каждое фото загружается ОДИН раз. Дальше телефон присылает только настройки
    # (уголки, режим, контраст…), а превью и PDF сервер делает из уже загруженного фото.

    def scan_page(pid: str, owners: set[str]) -> sqlite3.Row:
        row = store.one("SELECT * FROM scan_pages WHERE id=?", pid)
        if not row or row["owner"] not in owners or not store.scan_path(pid, "orig").exists():
            raise HTTPException(404, f"Страница не найдена — фото хранятся {settings.tool_ttl_min} минут")
        store.run("UPDATE scan_pages SET created=? WHERE id=?", time.time(), pid)  # продлеваем, пока работаем
        return row

    @app.post("/api/scan/pages")
    async def scan_add_pages(request: Request):
        _, owner, _ = tool_owner(request)
        limiter.hit(f"tool:{owner}", settings.tools_per_min, 60)
        ensure_disk_space()
        work = store.tmp_root / uuid.uuid4().hex
        work.mkdir(parents=True)
        pages = []
        try:
            form = await read_form(request, settings.tool_max_mb)
            try:
                uploads = [v for v in form.getlist("files") if isinstance(v, UploadFile)]
                if not uploads or len(uploads) > 20:
                    raise HTTPException(400, "Добавь от 1 до 20 фото за раз")
                for up in uploads:
                    name = safe_filename(up.filename)
                    mime = normalize_mime(up.content_type) or mimetypes.guess_type(name)[0] or ""
                    if not is_image(name, mime):
                        raise HTTPException(400, f"«{name}» — не фото")
                    pid = uuid.uuid4().hex
                    orig = store.scan_path(pid, "orig")
                    if await run_in_threadpool(copy_limited, up.file, orig, settings.tool_max_mb * MB) is None:
                        orig.unlink(missing_ok=True)
                        raise HTTPException(413, f"Слишком большое фото. Лимит {settings.tool_max_mb} МБ")
                    try:
                        info = (await converter_post("/scan/prepare", [(orig, name, mime)], {})).json()
                        store.scan_path(pid, "work").write_bytes(base64.b64decode(info["work"]))
                    except BaseException:
                        orig.unlink(missing_ok=True)
                        raise
                    store.run("INSERT INTO scan_pages (id, owner, name, created) VALUES (?,?,?,?)",
                              pid, owner, name, time.time())
                    pages.append({"id": pid, "name": name, "corners": info.get("corners"),
                                  "width": info.get("width"), "height": info.get("height"),
                                  "image_url": f"/s/{pid}/work"})
            finally:
                await form.close()
        except BaseException:
            for page in pages:  # что-то сломалось посреди пачки — убираем уже загруженное
                store.remove_scan_page(page["id"])
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return {"pages": pages}

    @app.get("/s/{pid}/work")
    async def scan_work_image(pid: str, request: Request):
        scan_page(pid, owner_from_cookies(request))
        return FileResponse(store.scan_path(pid, "work"), media_type="image/jpeg",
                            headers={"Content-Security-Policy": "sandbox"})

    @app.get("/s/{pid}/preview")
    async def scan_preview(pid: str, request: Request, p: str = ""):
        owners = owner_from_cookies(request)
        row = scan_page(pid, owners)
        limiter.hit(f"preview:{row['owner']}", 300, 60)
        if len(p) > 2000:
            raise HTTPException(400, "Слишком длинные параметры")
        response = await converter_post("/scan/render", [(store.scan_path(pid, "work"), "work.jpg", "image/jpeg")],
                                        {"params": p or "{}"})
        return Response(response.content, media_type="image/jpeg", headers={"Content-Security-Policy": "sandbox"})

    @app.post("/api/scan/pdf")
    async def scan_make_pdf(request: Request):
        _, owner, _ = tool_owner(request)
        limiter.hit(f"tool:{owner}", settings.tools_per_min, 60)
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("pages"), list) or not body["pages"]:
            raise HTTPException(400, "Добавь хотя бы одну страницу")
        if len(body["pages"]) > 50:
            raise HTTPException(400, "Не больше 50 страниц в одном PDF")
        common = {k: body.get(k) for k in ("mode", "contrast", "sharpness")}
        inputs, params = [], []
        for page in body["pages"]:
            pid = page.get("id") if isinstance(page, dict) else None
            row = scan_page(pid, {owner}) if isinstance(pid, str) else None
            if row is None:
                raise HTTPException(404, "Страница не найдена")
            inputs.append((store.scan_path(pid, "orig"), row["name"], "image/jpeg"))
            params.append({**common, "corners": page.get("corners"), "rot": page.get("rot", 0)})
        page_size = body.get("page_size") if body.get("page_size") in ("auto", "a4", "a5", "letter") else "auto"
        weight = body.get("weight") if body.get("weight") in ("light", "normal", "max") else "normal"
        title = safe_filename(body.get("name")) if isinstance(body.get("name"), str) else "Скан"
        name = title if title.lower().endswith(".pdf") else f"{title}.pdf"
        work = store.tmp_root / uuid.uuid4().hex
        try:
            outs = await run_converter("scan-pdf", inputs, {
                "pages": json.dumps(params), "page_size": page_size, "weight": weight}, work)
            results = save_results(owner, outs, [(name, "application/pdf")])
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return {"results": results, "ttl_min": settings.tool_ttl_min}

    @app.post("/api/tools/send")
    async def send_tool_results(request: Request):
        """«Отправить на компьютер»: кладём готовые файлы в выбранный чат."""
        role, owner, who = tool_owner(request)
        body = await request.json()
        ids = body.get("ids") if isinstance(body, dict) else None
        if not isinstance(ids, list) or not ids or len(ids) > 200:
            raise HTTPException(400, "Нечего отправлять")
        dev = who if role == "pc" else phone_chat(who, body.get("chat_id"))
        limiter.hit(f"send:{who['id']}", settings.sends_per_min, 60)
        rows = []
        for rid in ids:
            row = store.one("SELECT * FROM tool_results WHERE id=? AND owner=?", rid, owner) if isinstance(rid, str) else None
            if not row or not store.tool_path(rid).exists():
                raise HTTPException(404, f"Файл не найден — результаты хранятся {settings.tool_ttl_min} минут")
            rows.append(row)
        uploads = uploads_from_paths([(store.tool_path(r["id"]), r["name"], r["mime"]) for r in rows])
        try:
            items = await add_messages(dev, role, [], uploads, None, None)
        finally:
            for up in uploads:
                up.file.close()
        return {"messages": items, "chat_id": dev["id"]}

    @app.post("/api/tools/{op}")
    async def run_tool(op: str, request: Request):
        if op not in TOOL_OPS:
            raise HTTPException(404, "Неизвестный инструмент")
        role, owner, _ = tool_owner(request)
        limiter.hit(f"tool:{owner}", settings.tools_per_min, 60)
        ensure_disk_space()
        work = store.tmp_root / uuid.uuid4().hex
        (work / "in").mkdir(parents=True)
        try:
            form = await read_form(request, settings.tool_max_mb)
            try:
                inputs = []
                for i, up in enumerate(v for v in form.getlist("files") if isinstance(v, UploadFile)):
                    dest = work / "in" / f"{i:03d}"
                    if await run_in_threadpool(copy_limited, up.file, dest, settings.tool_max_mb * MB) is None:
                        raise HTTPException(413, f"Слишком большой размер. Лимит {settings.tool_max_mb} МБ за раз")
                    mime = normalize_mime(up.content_type) or mimetypes.guess_type(up.filename or "")[0] or ""
                    inputs.append((dest, safe_filename(up.filename), mime))
                options = {k: form.get(k) for k in ("mode", "rotations", "preset") if isinstance(form.get(k), str)}
                title = form.get("name") if isinstance(form.get("name"), str) else None
            finally:
                await form.close()
            check_tool_inputs(op, inputs)
            outs = await run_converter(op, inputs, options, work / "out")
            results = save_results(owner, outs, result_names(op, inputs, len(outs), title))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return {"results": results, "ttl_min": settings.tool_ttl_min}

    @app.get("/t/{rid}")
    async def get_tool_result(rid: str, request: Request, dl: int = 0):
        row = store.one("SELECT * FROM tool_results WHERE id=?", rid)
        if not row or row["owner"] not in owner_from_cookies(request) or not store.tool_path(rid).exists():
            raise HTTPException(404, f"Файл не найден — результаты хранятся {settings.tool_ttl_min} минут")
        headers = {}
        if (policy := file_csp(row["mime"])) is not None:
            headers["Content-Security-Policy"] = policy
        return FileResponse(store.tool_path(rid), media_type=row["mime"], filename=row["name"],
                            content_disposition_type="attachment" if dl else "inline", headers=headers)

    # ------------------------------------------------------- уведомления

    @app.post("/api/push/subscribe")
    async def push_subscribe(request: Request):
        role = role_of(request)
        owner = f"dev:{require_pc(request)['id']}" if role == "pc" else f"acc:{require_phone(request)['id']}"
        body = await request.json()
        try:
            endpoint = body["endpoint"]
            p256dh, auth = body["keys"]["p256dh"], body["keys"]["auth"]
        except (KeyError, TypeError):
            raise HTTPException(400, "Неверная подписка")
        if not (isinstance(endpoint, str) and endpoint.startswith("https://") and len(endpoint) < 1024
                and isinstance(p256dh, str) and len(p256dh) < 200 and isinstance(auth, str) and len(auth) < 100):
            raise HTTPException(400, "Неверная подписка")
        store.run("DELETE FROM push_subs WHERE endpoint=?", endpoint)
        store.run("INSERT INTO push_subs (endpoint, owner, p256dh, auth, created) VALUES (?,?,?,?,?)",
                  endpoint, owner, p256dh, auth, time.time())
        return {"ok": True}

    @app.post("/api/push/unsubscribe")
    async def push_unsubscribe(request: Request):
        role = role_of(request)
        owner = f"dev:{require_pc(request)['id']}" if role == "pc" else f"acc:{require_phone(request)['id']}"
        body = await request.json()
        endpoint = body.get("endpoint") if isinstance(body, dict) else None
        store.run("DELETE FROM push_subs WHERE endpoint=? AND owner=?", endpoint, owner)
        return {"ok": True}

    # ------------------------------------------------------------ WebSocket

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        try:
            check_origin(websocket.headers)
        except HTTPException:
            await websocket.close(code=4403)  # чужой сайт — даже не открываем соединение
            return
        role = websocket.query_params.get("role")
        dev = acc = None
        if role == "pc":
            dev = store.device_by_token(websocket.cookies.get(PC_COOKIE))
        elif role == "phone":
            acc = store.account_by_token(websocket.cookies.get(PHONE_COOKIE))
        await websocket.accept()
        if not (dev or acc):
            await websocket.send_json({"type": "closed", "reason": "unauthorized"})
            await websocket.close(code=4401)
            return

        if dev:
            pool, key = store.pc_sockets, dev["id"]
        else:
            pool, key = store.phone_sockets, acc["id"]
        pool[key].add(websocket)

        async def announce():
            if dev:
                current = store.device(dev["id"])
                if current and current["account_id"]:
                    await store.presence(current)
            else:
                for d in store.q("SELECT * FROM devices WHERE account_id=?", acc["id"]):
                    await store.presence(d)

        def touch():
            if dev:
                store.run("UPDATE devices SET last_seen=? WHERE id=?", time.time(), dev["id"])
            else:
                store.run("UPDATE accounts SET last_active=? WHERE id=?", time.time(), acc["id"])

        touch()
        await announce()
        try:
            while True:
                await websocket.receive_text()  # пинги от браузера держат соединение
                touch()
        except WebSocketDisconnect:
            pass
        finally:
            pool.get(key, set()).discard(websocket)
            if not pool.get(key):
                pool.pop(key, None)
            touch()
            await announce()

    return app


app = create_app()
