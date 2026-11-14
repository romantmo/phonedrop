"""Разбор письма (.eml из Gmail/Outlook в браузере или .msg из Outlook) для «Проверки письма».

Что делаем (для чайника):
- достаём заголовки (их дальше разбирает браузер — тот же разбор, что в «Заголовках письма»);
- собираем все ссылки из текста и HTML и отмечаем подозрительные (короткие, чужой бренд, текст ≠ адрес);
- перечисляем вложения и отмечаем опасные: программы, двойное расширение, макросы, архив с паролем.
Ничего не сохраняем и не открываем: вложения только читаются как байты (для антивируса и «отпечатка»).
"""

from __future__ import annotations

import email
import hashlib
import io
import re
import zipfile
from email import policy
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import olefile

from .i18n import T
from .nettools import _check, registrable, url_flags

MAX_LINKS = 60
MAX_ATTACHMENTS = 20
HEADERS_LIMIT = 200_000
BODY_LIMIT = 2_000_000

# Что запускается двойным щелчком (или открывается как программа/страница) — во вложении почти всегда опасно.
DANGER_EXT = {
    "exe", "scr", "com", "pif", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "ps1", "psm1",
    "msi", "msp", "msix", "appx", "lnk", "jar", "cpl", "reg", "iso", "img", "vhd", "vhdx", "one", "xll", "dll",
    "chm", "url", "application", "gadget", "inf", "scf", "settingcontent-ms",
}
WEB_EXT = {"html", "htm", "shtml", "xhtml", "svg", "mht", "mhtml"}
MACRO_EXT = {"docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm"}
OLD_OFFICE = {"doc", "dot", "xls", "xlt", "ppt", "pps"}
ARCHIVE_EXT = {"zip", "rar", "7z", "gz", "tgz", "tar", "cab", "ace", "arj", "z", "xz", "bz2"}
OOXML = {"docx", "xlsx", "pptx", "docm", "xlsm", "pptm", "dotx", "xltx", "potx"}
RTLO = "‮"


class MailError(Exception):
    pass


def _ext(name: str) -> str:
    return PurePosixPath(name.lower().strip(" .")).suffix.lstrip(".")


def _has_vba_ole(data: bytes) -> bool:
    try:
        ole = olefile.OleFileIO(io.BytesIO(data))
    except (OSError, ValueError):
        return False
    try:
        names = {"/".join(x).lower() for x in ole.listdir(streams=True, storages=True)}
    finally:
        ole.close()
    return any(n.endswith(("vba_project", "_vba_project")) or n.startswith(("macros", "_vba_project_cur"))
               or "/vba/" in f"/{n}/" for n in names)


def _zip_info(data: bytes) -> tuple[bool, list[str], bool]:
    """(зашифрован ли, имена внутри, есть ли vbaProject.bin). Только оглавление — ничего не распаковываем."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()[:500]
    except (zipfile.BadZipFile, OSError, ValueError):
        return False, [], False
    encrypted = any(i.flag_bits & 0x1 for i in infos)
    names = [i.filename for i in infos]
    return encrypted, names, any(n.lower().endswith("vbaproject.bin") for n in names)


def attachment_flags(name: str, data: bytes) -> list[dict]:
    flags = []
    clean = name.replace(RTLO, "")
    if RTLO in name:
        flags.append(_check("bad", T("В имени файла спрятан символ, переворачивающий текст — настоящее имя: {name}", name=clean)))
    ext = _ext(clean)
    stem_ext = _ext(PurePosixPath(clean.lower()).stem)
    if ext in DANGER_EXT:
        if stem_ext and stem_ext not in DANGER_EXT and len(stem_ext) <= 5:
            flags.append(_check("bad", T("Двойное расширение: выглядит как .{shown}, а на самом деле .{ext} — программа", shown=stem_ext, ext=ext)))
        else:
            flags.append(_check("bad", T("Файл .{ext} может запустить программу — не открывай, если не ждал его", ext=ext)))
    elif ext in WEB_EXT:
        flags.append(_check("warn", T("Веб-страница во вложении (.{ext}) — частый приём фишинга: откроет «вход в почту»", ext=ext)))
    if ext in MACRO_EXT:
        flags.append(_check("warn", T("Документ с макросами (.{ext}) — не нажимай «Включить содержимое»", ext=ext)))
    elif ext in OLD_OFFICE and _has_vba_ole(data):
        flags.append(_check("warn", T("В документе есть макросы — не нажимай «Включить содержимое»")))
    if ext in ARCHIVE_EXT or data[:4] == b"PK\x03\x04" and ext not in OOXML:
        encrypted, names, _ = _zip_info(data)
        if encrypted:
            flags.append(_check("warn", T("Архив с паролем: антивирус не может заглянуть внутрь — так прячут вирусы")))
        bad = [n for n in names if _ext(n) in DANGER_EXT]
        if bad:
            flags.append(_check("bad", T("Внутри архива программа: {names}", names=", ".join(bad[:3]))))
        elif ext in ARCHIVE_EXT and not names:
            flags.append(_check("info", T("Архив: содержимое проверяет только антивирус")))
    if ext in OOXML:
        _, _, vba = _zip_info(data)
        if vba and ext not in MACRO_EXT:
            flags.append(_check("bad", T("Документ притворяется обычным (.{ext}), но внутри макросы", ext=ext)))
    return flags


class _Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href.strip(), " ".join("".join(self._text).split())[:200]))
            self._href = None


URL_RE = re.compile(r"https?://[^\s<>\"'()\[\]]+", re.I)
DOMAINISH = re.compile(r"^(https?://)?([a-z0-9-]+\.)+[a-z]{2,}(/\S*)?$", re.I)


def link_report(pairs: list[tuple[str, str]]) -> list[dict]:
    seen, out = set(), []
    for href, text in pairs:
        if not re.match(r"^https?://", href, re.I) or href in seen:
            continue
        seen.add(href)
        try:
            host = (urlsplit(href).hostname or "").lower()
        except ValueError:
            continue
        flags = [f for f in url_flags(href) if f["status"] != "info" or f.get("kind") == "short"]
        shown = text.strip()
        if shown and DOMAINISH.match(shown):
            shown_host = (urlsplit(shown if "://" in shown else "http://" + shown).hostname or "").lower()
            if shown_host and registrable(shown_host) != registrable(host):
                flags.insert(0, _check("bad", T("Текст ссылки — {shown}, а ведёт она на {real}", shown=shown_host, real=host)))
        out.append({"url": href[:2000], "text": shown, "domain": registrable(host) if host else "", "flags": flags})
        if len(out) >= MAX_LINKS:
            break
    order = {"bad": 0, "warn": 1}
    return sorted(out, key=lambda x: min([order.get(f["status"], 2) for f in x["flags"]] or [3]))


def _links_from(plain: str, html: str) -> list[dict]:
    pairs = []
    if html:
        parser = _Links()
        try:
            parser.feed(html[:BODY_LIMIT])
        except Exception:  # noqa: BLE001 — кривой HTML в письме не должен ронять проверку
            pass
        pairs += parser.links
    pairs += [(u.rstrip(".,;:!?"), "") for u in URL_RE.findall(plain[:BODY_LIMIT])]
    return link_report(pairs)


def _attachment(name: str, data: bytes, mime: str) -> dict:
    return {"name": name[:200] or "file", "size": len(data), "mime": mime[:100],
            "sha256": hashlib.sha256(data).hexdigest(), "flags": attachment_flags(name or "file", data),
            "data": data}


# ------------------------------------------------------------------ .eml
def parse_eml(raw: bytes) -> dict:
    msg = email.message_from_bytes(raw, policy=policy.default)
    if not msg.keys():
        raise MailError(T("Это не похоже на письмо: нужен файл .eml или .msg"))
    head = re.split(rb"\r?\n\r?\n", raw, maxsplit=1)[0][:HEADERS_LIMIT].decode("utf-8", "replace")
    plain, html, atts = "", "", []
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        disposition = part.get_content_disposition()
        ctype = part.get_content_type()
        if filename or disposition == "attachment" or ctype == "message/rfc822":
            if len(atts) >= MAX_ATTACHMENTS:
                continue
            payload = part.get_payload(decode=True)
            if payload is None and ctype == "message/rfc822":
                inner = part.get_payload()
                payload = inner[0].as_bytes() if isinstance(inner, list) and inner else b""
            atts.append(_attachment(filename or "message.eml", payload or b"", ctype))
            continue
        if ctype in ("text/plain", "text/html"):
            try:
                text = part.get_content()
            except (LookupError, ValueError):
                text = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
            if ctype == "text/plain" and len(plain) < BODY_LIMIT:
                plain += text
            elif ctype == "text/html" and len(html) < BODY_LIMIT:
                html += text
    return {"headers": head, "subject": str(msg.get("subject", ""))[:300], "from": str(msg.get("from", ""))[:300],
            "links": _links_from(plain, html), "attachments": atts}


# ------------------------------------------------------------------ .msg
def _ole_text(ole: olefile.OleFileIO, prefix: str, prop: str) -> str:
    for kind, enc in (("001F", "utf-16-le"), ("001E", "cp1252")):
        path = f"{prefix}__substg1.0_{prop}{kind}"
        if ole.exists(path):
            return ole.openstream(path).read(BODY_LIMIT * 2).decode(enc, "replace").rstrip("\0")
    return ""


def parse_msg(raw: bytes) -> dict:
    try:
        ole = olefile.OleFileIO(io.BytesIO(raw))
    except (OSError, ValueError):
        raise MailError(T("Это не похоже на письмо: нужен файл .eml или .msg"))
    try:
        if not ole.exists("__properties_version1.0"):
            raise MailError(T("Это не похоже на письмо: нужен файл .eml или .msg"))
        head = _ole_text(ole, "", "007D")[:HEADERS_LIMIT]
        plain = _ole_text(ole, "", "1000")
        html = ""
        if ole.exists("__substg1.0_10130102"):
            html = ole.openstream("__substg1.0_10130102").read(BODY_LIMIT).decode("utf-8", "replace")
        elif ole.exists("__substg1.0_1013001F"):
            html = _ole_text(ole, "", "1013")
        atts = []
        for entry in sorted({e[0] for e in ole.listdir(streams=True, storages=True)
                             if e and e[0].startswith("__attach_version1.0_#")}):
            if len(atts) >= MAX_ATTACHMENTS:
                break
            prefix = f"{entry}/"
            name = _ole_text(ole, prefix, "3707") or _ole_text(ole, prefix, "3704") or "file"
            mime = _ole_text(ole, prefix, "370E") or "application/octet-stream"
            data = b""
            if ole.exists(f"{prefix}__substg1.0_37010102"):
                data = ole.openstream(f"{prefix}__substg1.0_37010102").read()
            elif ole.exists(f"{prefix}__substg1.0_3701000D"):
                name = (_ole_text(ole, prefix, "3001") or "message") + ".msg"
                mime = "application/vnd.ms-outlook"
            atts.append(_attachment(name, data, mime))
        subject = _ole_text(ole, "", "0037")
        sender = _ole_text(ole, "", "0C1A") or _ole_text(ole, "", "5D01")
    finally:
        ole.close()
    return {"headers": head, "subject": subject[:300], "from": sender[:300],
            "links": _links_from(plain, html), "attachments": atts}


def parse_mail(raw: bytes, filename: str) -> dict:
    if raw[:8] == bytes.fromhex("d0cf11e0a1b11ae1") or filename.lower().endswith(".msg"):
        return parse_msg(raw)
    return parse_eml(raw)
