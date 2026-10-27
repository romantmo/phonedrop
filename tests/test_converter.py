"""Автотесты конвертера: каждое преобразование на маленьких примерах."""

import io
import shutil
import zipfile
from pathlib import Path

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
