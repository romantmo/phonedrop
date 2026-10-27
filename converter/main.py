"""Конвертер PhoneDrop — отдельный маленький сервис.

Зачем отдельно: разбор чужих документов (Word, PDF, фото) — самое рискованное место.
Поэтому конвертер работает в своём контейнере: без интернета, без доступа к базе
и перепискам, с лимитами памяти и времени. Даже если какой-то файл окажется вредным,
он не доберётся до данных пользователей.

Снаружи сервис недоступен — к нему обращается только основное приложение по внутренней сети.
Ответ — zip-архив (без сжатия) с файлами-результатами по порядку.
"""

from __future__ import annotations

import io
import shutil
import tempfile
import zipfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from . import ops

MB = 1024 * 1024
MAX_INPUT = 300 * MB

app = FastAPI(title="PhoneDrop converter", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "office": bool(shutil.which("soffice") or shutil.which("libreoffice"))}


def _save(files: list[UploadFile], folder: Path) -> list[tuple[Path, str]]:
    saved, total = [], 0
    for i, up in enumerate(files):
        dest = folder / f"in-{i:03d}"
        with dest.open("wb") as out:
            while chunk := up.file.read(MB):
                total += len(chunk)
                if total > MAX_INPUT:
                    raise ops.ConvertError("Слишком большие файлы")
                out.write(chunk)
        ext = Path(up.filename or "").suffix.lower().lstrip(".")
        saved.append((dest, ext))
    return saved


def _run(op: str, inputs: list[tuple[Path, str]], form: dict, out_dir: Path) -> list[Path]:
    paths = [p for p, _ in inputs]
    if op == "office-pdf":
        if len(inputs) != 1:
            raise ops.ConvertError("Нужен ровно один документ")
        return ops.office_to_pdf(paths[0], inputs[0][1], out_dir)
    if op == "images-pdf":
        try:
            rotations = [int(x) for x in form.get("rotations", "").split(",") if x.strip()]
        except ValueError:
            rotations = []
        return ops.images_to_pdf(paths, out_dir, rotations, "doc" if form.get("mode") == "doc" else "color")
    if op == "merge-pdf":
        return ops.merge_pdfs(paths, out_dir)
    if op == "pdf-images":
        if len(inputs) != 1:
            raise ops.ConvertError("Нужен ровно один PDF")
        return ops.pdf_to_images(paths[0], out_dir)
    if op == "images-jpg":
        return ops.images_to_jpg(paths, out_dir, form.get("preset", "email"))
    raise HTTPException(404, "Неизвестная операция")


@app.post("/convert/{op}")
async def convert(op: str, request: Request):
    form = await request.form(max_files=MAX_INPUT // MB, max_fields=10)
    try:
        files = [v for v in form.getlist("files") if isinstance(v, UploadFile)]
        options = {k: v for k, v in form.items() if isinstance(v, str)}
        with tempfile.TemporaryDirectory(prefix="pdconv-") as tmp:
            tmp_path = Path(tmp)
            (tmp_path / "in").mkdir()
            (tmp_path / "out").mkdir()
            try:
                inputs = await run_in_threadpool(_save, files, tmp_path / "in")
                outputs = await run_in_threadpool(_run, op, inputs, options, tmp_path / "out")
            except ops.ConvertError as exc:
                raise HTTPException(422, str(exc))
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
                for i, path in enumerate(outputs):
                    zf.write(path, f"{i:03d}{path.suffix}")
    finally:
        await form.close()
    return Response(buf.getvalue(), media_type="application/zip")
