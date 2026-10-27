"""Сами преобразования файлов. Каждая функция получает пути к файлам и папку для результата.

Здесь нет ничего про сеть и пользователей — только «файл на входе → файл на выходе».
Поэтому эти функции легко проверять автотестами.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
import uuid
import warnings
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageFilter, ImageOps
from pillow_heif import register_heif_opener
from pypdf import PdfReader, PdfWriter

register_heif_opener()  # учим Pillow открывать HEIC/HEIF (фото с iPhone и некоторых Android)

# Защита от «бомб»: крошечный файл, который при распаковке становится картинкой на миллиарды
# пикселей и съедает всю память. Всё крупнее ~80 мегапикселей — ошибка.
Image.MAX_IMAGE_PIXELS = 80_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

MAX_PAGES_IN = 100      # фото в одном PDF
MAX_PDF_FILES = 30      # PDF за одно объединение
MAX_TOTAL_PAGES = 1000  # страниц в объединённом PDF
MAX_RENDER_PAGES = 50   # страниц PDF → картинки
OFFICE_TIMEOUT_SEC = 120

OFFICE_EXTS = {
    "doc", "docx", "docm", "odt", "rtf", "txt",
    "xls", "xlsx", "xlsm", "ods", "csv",
    "ppt", "pptx", "pps", "ppsx", "odp",
}

# LibreOffice тяжёлый: одновременно не больше двух конвертаций.
_office_slots = threading.Semaphore(2)


class ConvertError(Exception):
    """Понятная пользователю ошибка (текст показывается в приложении)."""


def _open_image(path: Path) -> Image.Image:
    try:
        img = Image.open(path)  # читает только заголовок — размер известен до распаковки
        if img.width * img.height > Image.MAX_IMAGE_PIXELS:
            raise ConvertError("Картинка слишком большая")
        img.load()
    except ConvertError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ConvertError("Картинка слишком большая")
    except Exception:
        raise ConvertError("Не получилось открыть картинку — файл повреждён или это не фото")
    # Телефоны часто сохраняют фото «боком» и пишут поворот в EXIF. Применяем его.
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        background = Image.new("RGB", img.size, "white")  # прозрачность → белый фон
        rgba = img.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[-1])
        img = background
    return img


def _fit(img: Image.Image, max_side: int) -> Image.Image:
    if max_side and max(img.size) > max_side:
        img = img.copy()
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return img


def _document_look(img: Image.Image) -> Image.Image:
    """Режим «Документ»: серый, контрастный, чуть резче — как у сканера."""
    gray = ImageOps.grayscale(img)
    gray = ImageOps.autocontrast(gray, cutoff=(1, 5))  # фон светлее, текст темнее
    return gray.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))


# ------------------------------------------------------------------ фото → PDF


def images_to_pdf(paths: list[Path], out_dir: Path, rotations: list[int] | None = None,
                  mode: str = "color") -> list[Path]:
    if not paths:
        raise ConvertError("Добавь хотя бы одно фото")
    if len(paths) > MAX_PAGES_IN:
        raise ConvertError(f"Слишком много страниц (максимум {MAX_PAGES_IN})")
    rotations = rotations or []
    pages = []
    for i, path in enumerate(paths):
        img = _open_image(path)
        angle = rotations[i] if i < len(rotations) else 0
        if angle % 360:
            img = img.rotate(-angle, expand=True)  # поворот по часовой стрелке
        img = _fit(img, 2480)  # 2480 px — лист A4 при 300 dpi, достаточно для печати
        if mode == "doc":
            img = _document_look(img)
        pages.append(img)
    out = out_dir / "result.pdf"
    # Подбираем «разрешение» так, чтобы длинная сторона страницы была как у A4 (29,7 см).
    resolution = max(max(p.size) for p in pages) / 11.69
    pages[0].save(out, "PDF", save_all=True, append_images=pages[1:], resolution=resolution, quality=85)
    return [out]


# --------------------------------------------------------------- объединить PDF


def _read_pdf(path: Path) -> PdfReader:
    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            raise ConvertError("Один из PDF защищён паролем — сначала сними защиту")
        len(reader.pages)
        return reader
    except ConvertError:
        raise
    except Exception:
        raise ConvertError("Не получилось открыть PDF — файл повреждён")


def merge_pdfs(paths: list[Path], out_dir: Path) -> list[Path]:
    if len(paths) < 2:
        raise ConvertError("Выбери хотя бы два PDF")
    if len(paths) > MAX_PDF_FILES:
        raise ConvertError(f"Слишком много файлов (максимум {MAX_PDF_FILES})")
    writer = PdfWriter()
    total = 0
    for path in paths:
        reader = _read_pdf(path)
        total += len(reader.pages)
        if total > MAX_TOTAL_PAGES:
            raise ConvertError(f"Слишком много страниц (максимум {MAX_TOTAL_PAGES})")
        writer.append(reader)
    out = out_dir / "result.pdf"
    with out.open("wb") as f:
        writer.write(f)
    return [out]


# --------------------------------------------------------------- PDF → картинки


def pdf_to_images(path: Path, out_dir: Path, dpi: int = 150) -> list[Path]:
    try:
        pdf = pdfium.PdfDocument(path)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ConvertError("PDF защищён паролем — сначала сними защиту")
        raise ConvertError("Не получилось открыть PDF — файл повреждён")
    try:
        count = len(pdf)
        if count > MAX_RENDER_PAGES:
            raise ConvertError(f"В PDF {count} страниц, максимум — {MAX_RENDER_PAGES}")
        outs = []
        for i in range(count):
            page = pdf[i]
            w, h = page.get_size()
            scale = min(dpi / 72, 4000 / max(w, h, 1))  # не больше 4000 px по длинной стороне
            img = page.render(scale=scale).to_pil().convert("RGB")
            out = out_dir / f"page-{i + 1:03d}.jpg"
            img.save(out, "JPEG", quality=88, optimize=True)
            outs.append(out)
            page.close()
        return outs
    finally:
        pdf.close()


# ------------------------------------------------------ сжатие фото / HEIC → JPG

PRESETS = {
    "email": (2048, 82),     # для почты и мессенджеров: обычно в 5–10 раз меньше
    "small": (1280, 75),     # ещё меньше
    "original": (0, 92),     # тот же размер, просто JPG (например, из HEIC)
}


def images_to_jpg(paths: list[Path], out_dir: Path, preset: str = "email") -> list[Path]:
    if not paths:
        raise ConvertError("Добавь хотя бы одно фото")
    if len(paths) > MAX_PAGES_IN:
        raise ConvertError(f"Слишком много фото (максимум {MAX_PAGES_IN})")
    max_side, quality = PRESETS.get(preset, PRESETS["email"])
    outs = []
    for i, path in enumerate(paths):
        img = _fit(_open_image(path), max_side)
        out = out_dir / f"photo-{i + 1:03d}.jpg"
        # Сохраняем без EXIF: из фото пропадут геолокация и модель телефона.
        img.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
        outs.append(out)
    return outs


# ------------------------------------------------------------ Office → PDF


def office_to_pdf(path: Path, ext: str, out_dir: Path) -> list[Path]:
    ext = ext.lower().lstrip(".")
    if ext not in OFFICE_EXTS:
        raise ConvertError("Этот тип файла нельзя превратить в PDF")
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise ConvertError("Конвертер документов не установлен")
    work = out_dir / "office"
    work.mkdir()
    src = work / f"document.{ext}"  # своё имя: никаких странных символов в командной строке
    shutil.copyfile(path, src)
    profile = out_dir / f"lo-profile-{uuid.uuid4().hex}"
    cmd = [
        soffice, "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
        f"-env:UserInstallation={profile.as_uri()}",
        "--convert-to", "pdf", "--outdir", str(work), str(src),
    ]
    env = {**os.environ, "HOME": str(out_dir)}
    with _office_slots:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env=env, start_new_session=True)
        try:
            proc.wait(timeout=OFFICE_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)  # убиваем LibreOffice вместе с дочерними процессами
            proc.wait()
            raise ConvertError("Документ слишком сложный — не успели превратить в PDF")
    out = work / "document.pdf"
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        raise ConvertError("Не получилось открыть документ — файл повреждён или защищён паролем")
    return [out]
