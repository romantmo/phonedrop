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
import multiprocessing
import os
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
# Любая операция (PDF, фото, Word) работает в отдельном процессе и убивается через это время.
# Так «вредный» файл с бесконечным циклом не займёт конвертер навсегда.
CONVERT_TIMEOUT_SEC = float(os.getenv("CONVERT_TIMEOUT_SEC", "180"))
# forkserver: новые процессы рождаются от «чистого» процесса-заготовки (без потоков сервера),
# с уже загруженными библиотеками — это и безопасно, и быстро.
_ctx = multiprocessing.get_context("forkserver")
_ctx.set_forkserver_preload(["converter.ops"])

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
    if op == "compress-pdf":
        if len(inputs) != 1:
            raise ops.ConvertError("Нужен ровно один PDF")
        return ops.compress_pdf(paths[0], out_dir, form.get("preset", "normal"))
    if op == "merge-pdf":
        return ops.merge_pdfs(paths, out_dir)
    if op == "pdf-images":
        if len(inputs) != 1:
            raise ops.ConvertError("Нужен ровно один PDF")
        return ops.pdf_to_images(paths[0], out_dir)
    if op == "images-jpg":
        return ops.images_to_jpg(paths, out_dir, form.get("preset", "email"))
    if op == "images-convert":
        return ops.images_convert(paths, out_dir, form.get("size", "orig"), form.get("format", "jpg"))
    if op in ("pdf-thumbs", "pdf-pages", "pdf-protect", "pdf-unprotect") and len(inputs) != 1:
        raise ops.ConvertError("Нужен ровно один PDF")
    if op == "pdf-thumbs":
        return ops.pdf_thumbs(paths[0], out_dir)
    if op == "pdf-pages":
        try:
            pages = json.loads(form.get("pages") or "[]")
        except ValueError:
            pages = None
        return ops.pdf_pages(paths[0], out_dir, pages, form.get("split") == "split")
    if op == "pdf-protect":
        return ops.pdf_protect(paths[0], out_dir, form.get("password"))
    if op == "pdf-unprotect":
        return ops.pdf_unprotect(paths[0], out_dir, form.get("password"))
    if op == "pdf-sign":
        if len(inputs) != 2:
            raise ops.ConvertError("Нужны PDF и подпись")
        try:
            params = json.loads(form.get("sign") or "{}")
        except ValueError:
            params = None
        return ops.pdf_sign(paths[0], paths[1], out_dir, params)
    raise HTTPException(404, "Неизвестная операция")


def _child(conn, op, inputs, form, out_dir):
    try:
        conn.send(("ok", [str(p) for p in _run(op, inputs, form, out_dir)]))
    except ops.ConvertError as exc:
        conn.send(("error", str(exc)))
    except HTTPException as exc:
        conn.send(("http", (exc.status_code, exc.detail)))
    except Exception as exc:  # noqa: BLE001 — сообщаем родителю, а не молча умираем
        conn.send(("crash", type(exc).__name__))
    finally:
        conn.close()


def _run_limited(op: str, inputs: list[tuple[Path, str]], form: dict, out_dir: Path) -> list[Path]:
    """_run в отдельном процессе с тайм-аутом (вызывается из потока)."""
    parent, child = _ctx.Pipe(duplex=False)
    proc = _ctx.Process(target=_child, args=(child, op, inputs, form, out_dir), daemon=True)
    proc.start()
    child.close()
    try:
        if not parent.poll(CONVERT_TIMEOUT_SEC):
            raise ops.ConvertError("Файл слишком сложный — не успели обработать")
        try:
            kind, value = parent.recv()
        except EOFError:
            raise ops.ConvertError("Не получилось обработать файл — он слишком тяжёлый или повреждён")
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        parent.close()
    if kind == "ok":
        return [Path(p) for p in value]
    if kind == "error":
        raise ops.ConvertError(value)
    if kind == "http":
        raise HTTPException(*value)
    raise RuntimeError(f"converter crashed: {value}")


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
                outputs = await run_in_threadpool(_run_limited, op, inputs, options, tmp_path / "out")
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
