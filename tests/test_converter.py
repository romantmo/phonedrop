"""Автотесты конвертера: каждое преобразование на маленьких примерах."""

import io
import shutil
import zipfile
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader, PdfWriter

from converter import ops
from converter.main import app

FIXTURES = Path(__file__).parent / "fixtures"
has_office = bool(shutil.which("soffice") or shutil.which("libreoffice"))
needs_office = pytest.mark.skipif(not has_office, reason="LibreOffice не установлен (проверяется в Docker-образе)")


def make_image(path: Path, size=(800, 600), color="red", fmt=None) -> Path:
    Image.new("RGB", size, color).save(path, fmt)
    return path


def make_pdf(path: Path, pages: int) -> Path:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=595, height=842)
    with path.open("wb") as f:
        writer.write(f)
    return path


def out_dir(tmp_path: Path, name: str) -> Path:
    path = tmp_path / name
    path.mkdir()
    return path


def unzip(content: bytes) -> list[bytes]:
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        return [zf.read(n) for n in sorted(zf.namelist())]


def test_photos_to_pdf_with_rotation_and_document_mode(tmp_path):
    a = make_image(tmp_path / "a.jpg", (800, 600))
    b = make_image(tmp_path / "b.png", (600, 800), "blue")
    (out,) = ops.images_to_pdf([a, b], tmp_path, rotations=[90, 0], mode="doc")
    pages = PdfReader(out).pages
    assert len(pages) == 2
    w, h = float(pages[0].mediabox.width), float(pages[0].mediabox.height)
    assert h > w  # первое фото повернули на 90° — страница стала вертикальной
    assert 830 < h < 850  # высота как у A4 (842 pt)


def test_heic_photo_is_supported(tmp_path):
    heic = make_image(tmp_path / "photo.heic", (1200, 900), fmt="HEIF")
    (jpg,) = ops.images_to_jpg([heic], tmp_path, "original")
    img = Image.open(jpg)
    assert (img.format, img.size) == ("JPEG", (1200, 900))


def test_compress_photo_and_strip_location(tmp_path):
    src = tmp_path / "big.jpg"
    img = Image.new("RGB", (4000, 3000), "green")
    exif = Image.Exif()
    exif[0x010F] = "Phone maker"  # в реальных фото здесь же лежит GPS
    img.save(src, exif=exif)
    (out,) = ops.images_to_jpg([src], tmp_path, "email")
    small = Image.open(out)
    assert max(small.size) == 2048
    assert not small.getexif()  # метаданные удалены


def test_image_bomb_is_rejected(tmp_path):
    bomb = make_image(tmp_path / "bomb.png", (10_000, 10_000), "white")  # 100 мегапикселей
    with pytest.raises(ops.ConvertError, match="слишком большая"):
        ops.images_to_jpg([bomb], tmp_path)


def test_not_an_image(tmp_path):
    fake = tmp_path / "fake.jpg"
    fake.write_bytes(b"MZ\x90\x00 definitely not a photo")
    with pytest.raises(ops.ConvertError):
        ops.images_to_pdf([fake], tmp_path)


def test_merge_pdfs(tmp_path):
    a, b = make_pdf(tmp_path / "a.pdf", 2), make_pdf(tmp_path / "b.pdf", 3)
    (out,) = ops.merge_pdfs([a, b], tmp_path)
    assert len(PdfReader(out).pages) == 5


def test_encrypted_pdf_gives_clear_error(tmp_path):
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.encrypt("secret")
    locked = tmp_path / "locked.pdf"
    with locked.open("wb") as f:
        writer.write(f)
    with pytest.raises(ops.ConvertError, match="паролем"):
        ops.merge_pdfs([locked, make_pdf(tmp_path / "b.pdf", 1)], tmp_path)
    with pytest.raises(ops.ConvertError, match="паролем"):
        ops.pdf_to_images(locked, tmp_path)


def test_pdf_to_images(tmp_path):
    pages = ops.pdf_to_images(make_pdf(tmp_path / "a.pdf", 3), tmp_path)
    assert len(pages) == 3
    assert Image.open(pages[0]).format == "JPEG"


def test_too_many_pages_to_render(tmp_path):
    with pytest.raises(ops.ConvertError, match="страниц"):
        ops.pdf_to_images(make_pdf(tmp_path / "big.pdf", ops.MAX_RENDER_PAGES + 1), tmp_path)


def test_office_rejects_unknown_types(tmp_path):
    with pytest.raises(ops.ConvertError):
        ops.office_to_pdf(tmp_path / "x", "exe", tmp_path)


@needs_office
@pytest.mark.parametrize("name", ["sample.docx", "sample.xlsx"])
def test_office_to_pdf(tmp_path, name):
    (out,) = ops.office_to_pdf(FIXTURES / name, Path(name).suffix, tmp_path)
    assert out.read_bytes().startswith(b"%PDF")
    text = PdfReader(out).pages[0].extract_text()
    assert "Роман" in text or "Договор" in text  # кириллица на месте


def test_http_api(tmp_path):
    client = TestClient(app)
    a = make_image(tmp_path / "a.jpg").read_bytes()
    r = client.post("/convert/images-pdf", data={"mode": "color"},
                    files=[("files", ("a.jpg", a, "image/jpeg")), ("files", ("b.jpg", a, "image/jpeg"))])
    assert r.status_code == 200
    (pdf,) = unzip(r.content)
    assert pdf.startswith(b"%PDF")

    r = client.post("/convert/merge-pdf", files=[("files", ("a.pdf", b"broken", "application/pdf"))] * 2)
    assert r.status_code == 422 and "PDF" in r.json()["detail"]
    assert client.post("/convert/format-disk").status_code == 404


# ------------------------------------------------------------------ сканер 2.0

def photo_of_page(path: Path, size=(1200, 1600)) -> Path:
    """«Фото листа на столе»: тёмный стол, светлый лист под углом, строки текста."""
    import cv2
    import numpy as np

    w, h = size
    page = np.full((1100, 780, 3), 235, np.uint8)
    for i in range(14):
        cv2.line(page, (60, 90 + i * 65), (60 + 500 + (i * 37) % 160, 90 + i * 65), (40, 40, 40), 9)
    src = np.float32([[0, 0], [779, 0], [779, 1099], [0, 1099]])
    dst = np.float32([[0.18 * w, 0.12 * h], [0.86 * w, 0.16 * h], [0.92 * w, 0.88 * h], [0.10 * w, 0.84 * h]])
    desk = np.full((h, w, 3), (90, 70, 55), np.uint8)
    warped = cv2.warpPerspective(page, cv2.getPerspectiveTransform(src, dst), (w, h))
    mask = cv2.warpPerspective(np.full(page.shape[:2], 255, np.uint8), cv2.getPerspectiveTransform(src, dst), (w, h))
    desk[mask > 0] = warped[mask > 0]
    Image.fromarray(desk).save(path, quality=90)
    return path


def test_scanner_finds_page_corners(tmp_path):
    from converter import scan

    rgb = scan.to_array(Image.open(photo_of_page(tmp_path / "p.jpg")))
    corners = scan.detect_corners(rgb)
    expected = [[0.18, 0.12], [0.86, 0.16], [0.92, 0.88], [0.10, 0.84]]
    for (x, y), (ex, ey) in zip(corners, expected):
        assert abs(x - ex) < 0.03 and abs(y - ey) < 0.03, corners


def test_scanner_modes(tmp_path):
    from converter import scan

    rgb = scan.to_array(Image.open(photo_of_page(tmp_path / "p.jpg")))
    corners = scan.detect_corners(rgb)
    flat = scan.process(rgb, corners, 0, "doc", 2, 1)
    h, w = flat.shape
    assert 1.15 < h / w < 1.55  # лист выровнен: снова «портретный» прямоугольник
    assert flat[h // 2, 20] > 200  # бумага стала белой, стола нет
    bw = scan.process(rgb, corners, 90, "bw", 2, 1)
    assert set(np.unique(bw)) <= {0, 255} and bw.shape[1] > bw.shape[0]  # ч/б и повёрнут
    color = scan.process(rgb, None, 0, "color", 2, 1)
    assert color.shape == rgb.shape
    assert scan.valid_corners([[0, 0], [1, 0], [1, 1]]) is None
    assert scan.valid_corners([[0, 0], [2, 0], [1, 1], [0, 1]]) is None


def test_scan_pdf_page_size_and_weight(tmp_path):
    photo = photo_of_page(tmp_path / "p.jpg")
    page = {"corners": [[0.18, 0.12], [0.86, 0.16], [0.92, 0.88], [0.10, 0.84]], "mode": "doc"}
    sizes = {}
    for page_size, weight in (("a4", "light"), ("a4", "max"), ("letter", "normal"), ("auto", "normal")):
        d = tmp_path / f"{page_size}-{weight}"
        d.mkdir()
        (out,) = ops.scan_to_pdf([photo], d, [page], page_size, weight)
        box = PdfReader(out).pages[0].mediabox
        sizes[(page_size, weight)] = (round(float(box.width)), round(float(box.height)), out.stat().st_size)
    assert sizes[("a4", "light")][:2] == (595, 842)
    assert sizes[("letter", "normal")][:2] == (612, 792)
    assert sizes[("a4", "light")][2] < sizes[("a4", "max")][2]  # «лёгкий» правда легче
    assert sizes[("auto", "normal")][1] == 842


def test_scan_pdf_black_and_white_is_tiny(tmp_path):
    photo = photo_of_page(tmp_path / "p.jpg")
    (gray,) = ops.scan_to_pdf([photo], tmp_path, [{"mode": "doc"}], "a4", "max")
    gray_size = gray.stat().st_size
    (bw,) = ops.scan_to_pdf([photo], tmp_path, [{"mode": "bw"}], "a4", "max")
    assert bw.stat().st_size < gray_size / 3


def test_scan_http(tmp_path):
    client = TestClient(app)
    photo = photo_of_page(tmp_path / "p.jpg").read_bytes()
    r = client.post("/scan/prepare", files={"files": ("p.jpg", photo, "image/jpeg")})
    info = r.json()
    assert len(info["corners"]) == 4 and (info["width"], info["height"]) == (1200, 1600)
    r = client.post("/scan/render", data={"params": '{"mode": "bw", "size": 400}'},
                    files={"files": ("p.jpg", photo, "image/jpeg")})
    assert r.headers["content-type"] == "image/jpeg"
    assert max(Image.open(io.BytesIO(r.content)).size) == 400


# ------------------------------------------------------------------ сжать PDF

def heavy_pdf(path: Path) -> Path:
    """PDF со «сканом»: большая фотография с шумом, сохранённая почти без сжатия."""
    rng = np.random.default_rng(1)
    noise = rng.integers(0, 60, (2400, 1800, 3), dtype=np.uint8)
    img = Image.fromarray(np.clip(noise + 180, 0, 255).astype(np.uint8))
    img.save(path, "PDF", resolution=200, quality=95)
    return path


def test_compress_pdf_presets(tmp_path):
    src = heavy_pdf(tmp_path / "scan.pdf")
    sizes = {}
    for preset in ("light", "normal", "max"):
        d = tmp_path / preset
        d.mkdir()
        (out,) = ops.compress_pdf(src, d, preset)
        sizes[preset] = out.stat().st_size
        assert len(PdfReader(out).pages) == 1
    assert sizes["light"] < sizes["normal"] <= sizes["max"] <= src.stat().st_size
    assert sizes["light"] < src.stat().st_size / 3


def test_compress_pdf_never_makes_file_bigger(tmp_path):
    src = make_pdf(tmp_path / "text.pdf", 3)  # без картинок — сжимать почти нечего
    (out,) = ops.compress_pdf(src, tmp_path, "light")
    assert out.stat().st_size <= src.stat().st_size
    assert len(PdfReader(out).pages) == 3


def test_compress_pdf_http(tmp_path):
    client = TestClient(app)
    data = heavy_pdf(tmp_path / "scan.pdf").read_bytes()
    r = client.post("/convert/compress-pdf", data={"preset": "light"},
                    files={"files": ("scan.pdf", data, "application/pdf")})
    (pdf,) = unzip(r.content)
    assert pdf.startswith(b"%PDF") and len(pdf) < len(data) / 3


# ------------------------------------------------------------ v2.2: новые инструменты


def make_text_pdf(tmp_path, pages=3, name="text.pdf"):
    """PDF с разными страницами (по ширине видно, какая где)."""
    writer = PdfWriter()
    for i in range(pages):
        writer.add_blank_page(width=200 + 100 * i, height=800)
    path = tmp_path / name
    with path.open("wb") as f:
        writer.write(f)
    return path


def test_images_convert_size_and_formats(tmp_path):
    src = tmp_path / "a.png"
    Image.new("RGBA", (3000, 1500), (10, 200, 30, 128)).save(src)
    for fmt, kind in (("jpg", "JPEG"), ("png", "PNG"), ("webp", "WEBP")):
        out_dir = tmp_path / fmt
        out_dir.mkdir()
        (out,) = ops.images_convert([src], out_dir, "1280", fmt)
        with Image.open(out) as img:
            assert img.format == kind and max(img.size) == 1280
            assert ("A" in img.getbands()) == (fmt != "jpg")  # прозрачность остаётся, кроме JPG
    out_dir = tmp_path / "orig"
    out_dir.mkdir()
    (out,) = ops.images_convert([src], out_dir, "orig", "jpg")
    with Image.open(out) as img:
        assert img.size == (3000, 1500)


def test_pdf_pages_reorder_rotate_delete_split(tmp_path):
    src = make_text_pdf(tmp_path, 3)
    (out,) = ops.pdf_pages(src, out_dir(tmp_path, "one"), [{"i": 2, "rot": 90}, {"i": 0}])
    reader = PdfReader(out)
    assert len(reader.pages) == 2  # страница 2 удалена
    assert float(reader.pages[0].mediabox.width) == 400 and reader.pages[0].rotation == 90
    assert float(reader.pages[1].mediabox.width) == 200
    parts = ops.pdf_pages(src, out_dir(tmp_path, "split"), [{"i": 0}, {"i": 1}, {"i": 2}], split=True)
    assert [len(PdfReader(p).pages) for p in parts] == [1, 1, 1]
    for bad in ([], [{"i": 3}], [{"i": 0, "rot": 45}], "x", [{"i": "0"}]):
        with pytest.raises(ops.ConvertError):
            ops.pdf_pages(src, out_dir(tmp_path, "bad" + str(abs(hash(str(bad))))), bad)


def test_pdf_thumbs(tmp_path):
    src = make_text_pdf(tmp_path, 2)
    thumbs = ops.pdf_thumbs(src, out_dir(tmp_path, "t"))
    assert len(thumbs) == 2
    with Image.open(thumbs[0]) as img:
        assert max(img.size) == 480


def test_pdf_password_set_and_remove(tmp_path):
    src = make_text_pdf(tmp_path, 2)
    (locked,) = ops.pdf_protect(src, out_dir(tmp_path, "lock"), "секрет-123")
    reader = PdfReader(locked)
    assert reader.is_encrypted and not reader.decrypt("wrong")
    with pytest.raises(ops.ConvertError, match="Неверный пароль"):
        ops.pdf_unprotect(locked, out_dir(tmp_path, "bad"), "wrong")
    (opened,) = ops.pdf_unprotect(locked, out_dir(tmp_path, "open"), "секрет-123")
    reader = PdfReader(opened)
    assert not reader.is_encrypted and len(reader.pages) == 2
    with pytest.raises(ops.ConvertError, match="нет пароля"):
        ops.pdf_unprotect(src, out_dir(tmp_path, "plain"), "x")
    with pytest.raises(ops.ConvertError):
        ops.pdf_protect(src, out_dir(tmp_path, "empty"), "")


def test_pdf_sign_puts_signature_where_shown(tmp_path):
    src = make_text_pdf(tmp_path, 2)
    sig = tmp_path / "sig.png"
    img = Image.new("RGBA", (400, 200), (0, 0, 0, 0))
    for x in range(50, 350):  # «росчерк» синей линией
        for dy in range(-3, 4):
            img.putpixel((x, 100 + dy + (x % 40) // 10), (20, 30, 120, 255))
    img.save(sig)
    (out,) = ops.pdf_sign(src, sig, out_dir(tmp_path, "s"), {"page": 1, "x": 0.5, "y": 0.5, "w": 0.4})
    reader = PdfReader(out)
    assert len(reader.pages) == 2
    assert not list(reader.pages[0].images)
    assert len(list(reader.pages[1].images)) == 1
    # Подпись видна именно в правой нижней части второй страницы (300×800): проверяем по картинке.
    pdf = pdfium.PdfDocument(out)
    page_img = pdf[1].render(scale=1).to_pil().convert("L")
    w, h = page_img.size
    assert page_img.crop((int(w * 0.5), int(h * 0.5), w, h)).getextrema()[0] < 120  # есть тёмные пиксели
    assert page_img.crop((0, 0, int(w * 0.5), int(h * 0.5))).getextrema()[0] > 240  # слева сверху пусто
    pdf.close()
    blank = tmp_path / "blank.png"
    Image.new("RGBA", (100, 50), (0, 0, 0, 0)).save(blank)
    with pytest.raises(ops.ConvertError, match="пустая"):
        ops.pdf_sign(src, blank, out_dir(tmp_path, "b"), {"page": 0, "x": 0.1, "y": 0.1, "w": 0.3})
    with pytest.raises(ops.ConvertError):
        ops.pdf_sign(src, sig, out_dir(tmp_path, "c"), {"page": 5, "x": 0.1, "y": 0.1, "w": 0.3})


def test_pdf_sign_on_rotated_page(tmp_path):
    src = make_text_pdf(tmp_path, 1)
    rotated = tmp_path / "rot.pdf"
    w = PdfWriter(clone_from=PdfReader(src))
    w.pages[0].rotate(90)
    with rotated.open("wb") as f:
        w.write(f)
    sig = tmp_path / "sig.png"
    Image.new("RGBA", (200, 100), (0, 0, 0, 255)).save(sig)
    (out,) = ops.pdf_sign(rotated, sig, out_dir(tmp_path, "r"), {"page": 0, "x": 0.0, "y": 0.0, "w": 0.3})
    pdf = pdfium.PdfDocument(out)
    img = pdf[0].render(scale=1).to_pil().convert("L")
    pdf.close()
    W, H = img.size
    assert W > H  # страница лежит боком, как на экране
    assert img.getpixel((5, 5)) < 60  # подпись в левом верхнем углу видимой страницы
    assert img.getpixel((W - 5, H - 5)) > 240
