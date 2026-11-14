"""Сами преобразования файлов. Каждая функция получает пути к файлам и папку для результата.

Здесь нет ничего про сеть и пользователей — только «файл на входе → файл на выходе».
Поэтому эти функции легко проверять автотестами.
"""

from __future__ import annotations

import io
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
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject

from . import scan

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


def _open_image(path: Path, keep_alpha: bool = False) -> Image.Image:
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
    if keep_alpha and img.mode in ("RGBA", "LA", "P", "PA"):
        return img.convert("RGBA")
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


# ------------------------------------------------------------------- сканер 2.0


def _page_params(raw: dict | None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    mode = raw.get("mode") if raw.get("mode") in scan.MODES else "doc"

    def num(key, default):
        try:
            return int(raw.get(key, default))
        except (TypeError, ValueError):
            return default

    return {
        "corners": scan.valid_corners(raw.get("corners")) if raw.get("corners") else None,
        "rot": num("rot", 0) % 360,
        "mode": mode,
        "contrast": num("contrast", 2),
        "sharpness": num("sharpness", 1),
    }


def scan_prepare(path: Path, out_dir: Path, max_side: int = 1400) -> dict:
    """Новая страница: находим лист и делаем уменьшенную «рабочую» копию для превью."""
    rgb = scan.to_array(_open_image(path))
    corners = scan.detect_corners(rgb)
    work = out_dir / "work.jpg"
    scan.to_image(scan.fit(rgb, max_side)).save(work, "JPEG", quality=85)
    h, w = rgb.shape[:2]
    return {"corners": corners, "width": w, "height": h, "work": work}


def scan_render(path: Path, out_dir: Path, params: dict | None, max_side: int = 900) -> Path:
    """Превью одной страницы с уголками, режимом, контрастом и резкостью."""
    p = _page_params(params)
    rgb = scan.fit(scan.to_array(_open_image(path)), 1400)
    arr = scan.fit(scan.process(rgb, p["corners"], p["rot"], p["mode"], p["contrast"], p["sharpness"]), max_side)
    out = out_dir / "preview.jpg"
    scan.to_image(arr).save(out, "JPEG", quality=80)
    return out


def _place_on_page(img: Image.Image, page_size: str, max_side: int) -> tuple[Image.Image, float]:
    """Кладёт страницу на лист нужного формата. Возвращает картинку и её «dpi» для PDF."""
    if page_size not in scan.PAGE_SIZES:  # «как на фото»: лист по пропорциям снимка, длинная сторона как у A4
        k = max_side / max(img.size)  # у всех страниц одинаковая длинная сторона → одинаковый «dpi»
        img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.Resampling.LANCZOS)
        return img, max_side / (scan.PAGE_SIZES["a4"][1] / 72)
    pw, ph = scan.PAGE_SIZES[page_size]
    if img.width > img.height:
        pw, ph = ph, pw  # широкая страница — лист кладём горизонтально
    dpi = max_side / (max(pw, ph) / 72)
    canvas_w, canvas_h = round(pw / 72 * dpi), round(ph / 72 * dpi)
    img = img.copy()
    img.thumbnail((canvas_w, canvas_h), Image.Resampling.LANCZOS)
    canvas = Image.new(img.mode, (canvas_w, canvas_h), 255 if img.mode in ("1", "L") else "white")
    canvas.paste(img, ((canvas_w - img.width) // 2, (canvas_h - img.height) // 2))
    return canvas, dpi


def scan_to_pdf(paths: list[Path], out_dir: Path, pages: list | None = None,
                page_size: str = "auto", weight: str = "normal") -> list[Path]:
    if not paths:
        raise ConvertError("Добавь хотя бы одну страницу")
    if len(paths) > MAX_PAGES_IN:
        raise ConvertError(f"Слишком много страниц (максимум {MAX_PAGES_IN})")
    pages = pages if isinstance(pages, list) else []
    max_side, quality = scan.WEIGHTS.get(weight, scan.WEIGHTS["normal"])
    out = out_dir / "result.pdf"
    writer = PdfWriter()
    for i, path in enumerate(paths):
        p = _page_params(pages[i] if i < len(pages) else None)
        arr = scan.process(scan.to_array(_open_image(path)), p["corners"], p["rot"],
                           p["mode"], p["contrast"], p["sharpness"])
        img, dpi = _place_on_page(scan.to_image(arr), page_size, max_side)
        del arr
        if p["mode"] == "bw":
            img = img.convert("1", dither=Image.Dither.NONE)  # 1 бит на точку: в PDF сжимается как факс
        # Каждую страницу сразу сохраняем в отдельный PDF — в памяти держим только одну страницу.
        page_pdf = out_dir / f"page-{i:03d}.pdf"
        extra = {} if img.mode == "1" else {"quality": quality}  # для ч/б «качество JPEG» не применяется
        img.save(page_pdf, "PDF", resolution=dpi, **extra)
        writer.append(PdfReader(page_pdf))
    with out.open("wb") as f:
        writer.write(f)
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


# ------------------------------------------------------------------ сжать PDF

# Самая длинная сторона картинки внутри PDF и качество JPEG.
PDF_PRESETS = {
    "light": (1240, 45),   # маленький: ~150 dpi для листа A4
    "normal": (1754, 65),  # средний: ~210 dpi
    "max": (2480, 80),     # высокое качество: 300 dpi
}


def compress_pdf(path: Path, out_dir: Path, preset: str = "normal") -> list[Path]:
    """Уменьшает PDF: пережимает картинки внутри (сканы, фото). Текст остаётся текстом —
    его можно выделять и искать. Если меньше не получилось — возвращаем исходный файл."""
    max_side, quality = PDF_PRESETS.get(preset, PDF_PRESETS["normal"])
    reader = _read_pdf(path)
    if len(reader.pages) > MAX_TOTAL_PAGES:
        raise ConvertError(f"Слишком много страниц (максимум {MAX_TOTAL_PAGES})")
    writer = PdfWriter(clone_from=reader)
    for page in writer.pages:
        try:
            images = list(page.images)
        except Exception:
            images = []
        for img in images:
            try:
                xobj = img.indirect_reference.get_object() if img.indirect_reference else {}
                # Прозрачность, маски и чёрно-белые (факс) картинки не трогаем — они и так лёгкие
                # или после пережатия испортятся.
                if any(k in xobj for k in ("/SMask", "/Mask", "/ImageMask")):
                    continue
                pil = img.image
                if pil.mode not in ("RGB", "L") or pil.width * pil.height > Image.MAX_IMAGE_PIXELS:
                    continue
                before = len(img.data)
                small = _fit(pil, max_side)
                buf = io.BytesIO()
                small.save(buf, "JPEG", quality=quality, optimize=True)
                if buf.tell() < before * 0.9:  # меняем, только если стало заметно легче
                    img.replace(small, quality=quality)
            except Exception:
                continue  # необычный формат картинки — оставляем как есть
        page.compress_content_streams()
    writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
    out = out_dir / "result.pdf"
    with out.open("wb") as f:
        writer.write(f)
    if out.stat().st_size >= path.stat().st_size:
        shutil.copyfile(path, out)  # исходный уже оптимален
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


# ------------------------------------------------------- фото: размер и формат

IMAGE_FORMATS = {"jpg": ("JPEG", "jpg"), "png": ("PNG", "png"), "webp": ("WEBP", "webp")}
IMAGE_SIZES = {"orig": 0, "2048": 2048, "1280": 1280, "800": 800}


def images_convert(paths: list[Path], out_dir: Path, size: str = "orig", fmt: str = "jpg") -> list[Path]:
    """Уменьшить фото по длинной стороне и/или сохранить в другом формате (JPG, PNG, WebP).
    Данные о месте съёмки и телефоне (EXIF) не сохраняются."""
    if not paths:
        raise ConvertError("Добавь хотя бы одно фото")
    if len(paths) > MAX_PAGES_IN:
        raise ConvertError(f"Слишком много фото (максимум {MAX_PAGES_IN})")
    pil_format, ext = IMAGE_FORMATS.get(fmt, IMAGE_FORMATS["jpg"])
    max_side = IMAGE_SIZES.get(size, 0)
    outs = []
    for i, path in enumerate(paths):
        img = _fit(_open_image(path, keep_alpha=pil_format != "JPEG"), max_side)
        out = out_dir / f"photo-{i + 1:03d}.{ext}"
        if pil_format == "JPEG":
            img.save(out, "JPEG", quality=88, optimize=True, progressive=True)
        elif pil_format == "PNG":
            img.save(out, "PNG", optimize=True)
        else:
            img.save(out, "WEBP", quality=85, method=4)
        outs.append(out)
    return outs


# ---------------------------------------------------- страницы PDF: превью и правка

MAX_EDIT_PAGES = 100  # страниц в PDF для «Страниц PDF» и «Подписать»


def _open_pdfium(path: Path) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(path)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ConvertError("PDF защищён паролем — сначала сними защиту")
        raise ConvertError("Не получилось открыть PDF — файл повреждён")


def pdf_thumbs(path: Path, out_dir: Path, max_side: int = 480) -> list[Path]:
    """Маленькие картинки страниц — чтобы на экране было видно, что где."""
    pdf = _open_pdfium(path)
    try:
        count = len(pdf)
        if count > MAX_EDIT_PAGES:
            raise ConvertError(f"В PDF {count} страниц, максимум — {MAX_EDIT_PAGES}")
        outs = []
        for i in range(count):
            page = pdf[i]
            w, h = page.get_size()
            img = page.render(scale=max_side / max(w, h, 1)).to_pil().convert("RGB")
            out = out_dir / f"thumb-{i + 1:03d}.jpg"
            img.save(out, "JPEG", quality=72)
            outs.append(out)
            page.close()
        return outs
    finally:
        pdf.close()


def _page_list(raw, count: int) -> list[tuple[int, int]]:
    """Список страниц из приложения: [{"i": номер с 0, "rot": 0/90/180/270}, ...] в нужном порядке."""
    if not isinstance(raw, list) or not raw:
        raise ConvertError("Оставь хотя бы одну страницу")
    if len(raw) > MAX_TOTAL_PAGES:
        raise ConvertError(f"Слишком много страниц (максимум {MAX_TOTAL_PAGES})")
    pages = []
    for item in raw:
        if not isinstance(item, dict):
            raise ConvertError("Неверный список страниц")
        i, rot = item.get("i"), item.get("rot", 0)
        if not isinstance(i, int) or not 0 <= i < count or rot not in (0, 90, 180, 270):
            raise ConvertError("Неверный список страниц")
        pages.append((i, rot))
    return pages


def pdf_pages(path: Path, out_dir: Path, raw_pages, split: bool = False) -> list[Path]:
    """Собрать PDF из выбранных страниц: порядок, поворот, удаление. split — каждая страница отдельным PDF."""
    reader = _read_pdf(path)
    pages = _page_list(raw_pages, len(reader.pages))
    if split and len(pages) > 200:
        raise ConvertError("Слишком много файлов (максимум 200)")
    groups = [[p] for p in pages] if split else [pages]
    outs = []
    for n, group in enumerate(groups):
        writer = PdfWriter()
        for i, rot in group:
            page = writer.add_page(reader.pages[i])
            if rot:
                page.rotate(rot)
        out = out_dir / f"part-{n + 1:03d}.pdf"
        with out.open("wb") as f:
            writer.write(f)
        outs.append(out)
    return outs


# ------------------------------------------------------------- пароль на PDF


def _check_password(password) -> str:
    if not isinstance(password, str) or not 1 <= len(password) <= 128:
        raise ConvertError("Пароль — от 1 до 128 символов")
    return password


def pdf_protect(path: Path, out_dir: Path, password) -> list[Path]:
    """Поставить пароль на открытие (шифрование AES-256)."""
    password = _check_password(password)
    reader = _read_pdf(path)
    writer = PdfWriter(clone_from=reader)
    writer.encrypt(user_password=password, owner_password=None, algorithm="AES-256")
    out = out_dir / "result.pdf"
    with out.open("wb") as f:
        writer.write(f)
    return [out]


def pdf_unprotect(path: Path, out_dir: Path, password) -> list[Path]:
    """Снять пароль, если его знаешь."""
    password = _check_password(password)
    try:
        reader = PdfReader(path)
        encrypted = reader.is_encrypted
    except Exception:
        raise ConvertError("Не получилось открыть PDF — файл повреждён")
    if not encrypted:
        raise ConvertError("У этого PDF нет пароля")
    try:
        ok = reader.decrypt(password)
    except Exception:
        ok = 0
    if not ok:
        raise ConvertError("Неверный пароль")
    writer = PdfWriter(clone_from=reader)
    out = out_dir / "result.pdf"
    with out.open("wb") as f:
        writer.write(f)
    return [out]


# -------------------------------------------------------------- подписать PDF


def _signature_image(path: Path) -> Image.Image:
    """Подпись с телефона: PNG с прозрачным фоном. Обрезаем пустые края."""
    try:
        img = Image.open(path)
        if img.width * img.height > 4_000_000:
            raise ConvertError("Подпись слишком большая")
        img = img.convert("RGBA")
    except ConvertError:
        raise
    except Exception:
        raise ConvertError("Не получилось прочитать подпись")
    box = img.getchannel("A").getbbox()
    if not box:
        raise ConvertError("Подпись пустая — нарисуй её ещё раз")
    return img.crop(box)


def _image_stream(img: Image.Image, gray: bool = False):
    stream = DecodedStreamObject()
    stream.set_data(img.tobytes())
    stream = stream.flate_encode()
    stream.update({
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Image"),
        NameObject("/Width"): NumberObject(img.width),
        NameObject("/Height"): NumberObject(img.height),
        NameObject("/ColorSpace"): NameObject("/DeviceGray" if gray else "/DeviceRGB"),
        NameObject("/BitsPerComponent"): NumberObject(8),
    })
    return stream


def pdf_sign(path: Path, sig_path: Path, out_dir: Path, params) -> list[Path]:
    """Ставит подпись (картинку) на страницу. params: page — номер с 0; x, y — левый верхний угол
    подписи, w — её ширина; всё в долях видимой страницы (0…1), как человек видел на экране."""
    if not isinstance(params, dict):
        raise ConvertError("Неверное место для подписи")
    try:
        index = int(params.get("page"))
        x, y, w = (float(params.get(k)) for k in ("x", "y", "w"))
    except (TypeError, ValueError):
        raise ConvertError("Неверное место для подписи")
    if not (0 <= x < 1 and 0 <= y < 1 and 0.02 <= w <= 1):
        raise ConvertError("Неверное место для подписи")
    reader = _read_pdf(path)
    if not 0 <= index < len(reader.pages):
        raise ConvertError("Неверное место для подписи")
    sig = _signature_image(sig_path)

    writer = PdfWriter(clone_from=reader)
    page = writer.pages[index]
    page.transfer_rotation_to_content()  # повёрнутая страница: координаты как на экране
    box = page.cropbox
    pw, ph = float(box.width), float(box.height)
    width = w * pw
    height = width * sig.height / sig.width
    left = float(box.left) + x * pw
    bottom = float(box.top) - y * ph - height

    # Отдельная страница-«наклейка» с подписью, которую накладываем поверх нужной страницы.
    stamp = PdfWriter()
    sheet = stamp.add_blank_page(width=float(page.mediabox.right) + 1, height=float(page.mediabox.top) + 1)
    rgb = _image_stream(sig.convert("RGB"))
    rgb[NameObject("/SMask")] = stamp._add_object(_image_stream(sig.getchannel("A"), gray=True))
    content = DecodedStreamObject()
    content.set_data(f"q {width:.3f} 0 0 {height:.3f} {left:.3f} {bottom:.3f} cm /PdSign Do Q".encode())
    sheet[NameObject("/Resources")] = DictionaryObject({
        NameObject("/XObject"): DictionaryObject({NameObject("/PdSign"): stamp._add_object(rgb)}),
    })
    sheet[NameObject("/Contents")] = stamp._add_object(content)
    sheet[NameObject("/MediaBox")] = ArrayObject([FloatObject(v) for v in page.mediabox])
    buf = io.BytesIO()
    stamp.write(buf)
    buf.seek(0)
    page.merge_page(PdfReader(buf).pages[0])

    out = out_dir / "result.pdf"
    with out.open("wb") as f:
        writer.write(f)
    return [out]
