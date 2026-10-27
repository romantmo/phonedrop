"""Конвертер PhoneDrop — отдельный маленький сервис.

Зачем отдельно: разбор чужих документов (Word, PDF, фото) — самое рискованное место.
Поэтому конвертер работает в своём контейнере: без интернета, без доступа к базе
и перепискам, с лимитами памяти и времени. Даже если какой-то файл окажется вредным,
он не доберётся до данных пользователей.

Снаружи сервис недоступен — к нему обращается только основное приложение по внутренней сети.
Ответ — zip-архив (без сжатия) с файлами-результатами по порядку.
"""

from __future__ import annotations

import base64
import io
import json
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
    if op == "scan-pdf":
        try:
            pages = json.loads(form.get("pages") or "[]")
        except ValueError:
            pages = []
        return ops.scan_to_pdf(paths, out_dir, pages, form.get("page_size", "auto"), form.get("weight", "normal"))
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


# ---------------------------------------------------------------- сканер


async def _one_file(request: Request, work: Path) -> tuple[Path, dict]:
    form = await request.form(max_files=1, max_fields=5)
    try:
        files = [v for v in form.getlist("files") if isinstance(v, UploadFile)]
        if len(files) != 1:
            raise HTTPException(400, "Нужен ровно один файл")
        (path, _), = await run_in_threadpool(_save, files, work)
        try:
            params = json.loads(form.get("params") or "{}")
        except ValueError:
            params = {}
        return path, params
    finally:
        await form.close()


@app.post("/scan/prepare")
async def scan_prepare(request: Request):
    """Новая страница: уголки листа + уменьшенная копия для превью."""
    with tempfile.TemporaryDirectory(prefix="pdscan-") as tmp:
        path, _ = await _one_file(request, Path(tmp))
        try:
            info = await run_in_threadpool(ops.scan_prepare, path, Path(tmp))
        except ops.ConvertError as exc:
            raise HTTPException(422, str(exc))
        work = base64.b64encode(info.pop("work").read_bytes()).decode()
    return {**info, "work": work}


@app.post("/scan/render")
async def scan_render(request: Request):
    """Превью страницы с выбранными уголками и настройками."""
    with tempfile.TemporaryDirectory(prefix="pdscan-") as tmp:
        path, params = await _one_file(request, Path(tmp))
        try:
            size = min(max(int(params.get("size", 900)), 200), 1400)
        except (TypeError, ValueError):
            size = 900
        try:
            out = await run_in_threadpool(ops.scan_render, path, Path(tmp), params, size)
        except ops.ConvertError as exc:
            raise HTTPException(422, str(exc))
        data = out.read_bytes()
    return Response(data, media_type="image/jpeg")
