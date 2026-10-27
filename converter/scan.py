"""Сканер: найти лист на фото, выровнять его и сделать «как из сканера».

Шаги для каждой страницы:
  1) поворот по EXIF (телефон часто пишет «фото боком» в метаданные);
  2) выравнивание: 4 уголка листа → ровный прямоугольник (перспектива как у CamScanner);
  3) поворот на 90/180/270, если пользователь нажал ⟳;
  4) режим: цвет / документ (серый) / ч-б / оригинал;
  5) контраст и резкость (ползунки 0…4).
Уголки передаются в долях от ширины и высоты (0…1), поэтому одни и те же уголки
подходят и к маленькому превью, и к полному фото.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

MODES = ("color", "doc", "bw", "original")

# Размеры листов в пунктах (1 пункт = 1/72 дюйма), портретная ориентация.
PAGE_SIZES = {
    "a4": (595.28, 841.89),
    "a5": (419.53, 595.28),
    "letter": (612.0, 792.0),
}

# Размер (вес) файла: самая длинная сторона страницы в пикселях и качество JPEG.
# Замеры на плотной странице книги: маленький ≈ 140–175 КБ, средний ≈ 325–450 КБ, высокое ≈ 0,85–1,3 МБ.
# Режим «Ч/Б» в любом варианте — десятки КБ на страницу.
WEIGHTS = {
    "light": (1240, 45),   # маленький: ~150 dpi на A4, для WhatsApp и почты
    "normal": (1754, 65),  # средний: ~210 dpi
    "max": (2480, 85),     # высокое качество: 300 dpi на A4, для печати
}


def to_array(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"))


def to_image(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(arr, "L" if arr.ndim == 2 else "RGB")


# ------------------------------------------------------------- поиск листа


def _order(pts: np.ndarray) -> np.ndarray:
    """Порядок уголков: левый верхний, правый верхний, правый нижний, левый нижний."""
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)


def detect_corners(rgb: np.ndarray) -> list[list[float]] | None:
    """Ищет самый большой четырёхугольник (лист). None — если не нашли."""
    h, w = rgb.shape[:2]
    scale = 600 / max(h, w)
    small = cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    sh, sw = gray.shape
    min_area = 0.2 * sh * sw
    margin = 0.015 * max(sh, sw)

    def touches_frame(quad: np.ndarray) -> int:
        """Сколько уголков лежит на краю кадра (так бывает, когда «лист» — это весь стол)."""
        return sum(1 for x, y in quad if x < margin or y < margin or x > sw - margin or y > sh - margin)

    # Пробуем два способа: по краям (Canny) и по яркости (лист обычно светлее стола).
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edges = cv2.dilate(cv2.Canny(gray, 40, 120), np.ones((5, 5), np.uint8))
    candidates = []
    for mask in (edges, cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))):
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
            if cv2.contourArea(c) < min_area:
                break
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            quad = None
            for eps in (0.02, 0.03, 0.05, 0.08):
                approx = cv2.approxPolyDP(hull, eps * peri, True)
                if len(approx) == 4:
                    quad = approx
                    break
            if quad is None:
                quad = cv2.boxPoints(cv2.minAreaRect(hull))
            quad = _order(np.array(quad))
            quad_area = cv2.contourArea(quad)
            if min_area <= quad_area <= 0.98 * sh * sw:
                candidates.append((touches_frame(quad) >= 2, -quad_area, quad))
    if not candidates:
        return None
    # Лучший — самый большой четырёхугольник, который НЕ упирается в края кадра.
    best = min(candidates, key=lambda c: (c[0], c[1]))
    pts = best[2] / np.array([sw, sh], np.float32)
    return [[round(float(min(max(x, 0), 1)), 4), round(float(min(max(y, 0), 1)), 4)] for x, y in pts]


def valid_corners(corners) -> list[list[float]] | None:
    """Проверяет уголки от пользователя: 4 точки в пределах 0…1, не «вывернутые»."""
    try:
        pts = [[float(x), float(y)] for x, y in corners]
    except (TypeError, ValueError):
        return None
    if len(pts) != 4 or not all(0 <= v <= 1 for p in pts for v in p):
        return None
    if cv2.contourArea(np.array(pts, np.float32)) < 0.01:  # слишком маленькая площадь
        return None
    return pts


# ------------------------------------------------------------ обработка


def warp(rgb: np.ndarray, corners: list[list[float]]) -> np.ndarray:
    h, w = rgb.shape[:2]
    src = _order(np.array(corners, np.float32) * np.array([w, h], np.float32))
    tl, tr, br, bl = src
    # Размер ровной страницы — средняя длина противоположных сторон.
    out_w = int(round((np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2))
    out_h = int(round((np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2))
    out_w, out_h = max(out_w, 16), max(out_h, 16)
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], np.float32)
    matrix = cv2.getPerspectiveTransform(src, dst)
    flat = cv2.warpPerspective(rgb, matrix, (out_w, out_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    # Срезаем тонкую полоску по краям: там часто остаётся край стола (на ч/б — чёрная рамка).
    if corners != [[0, 0], [1, 0], [1, 1], [0, 1]]:
        m = max(1, round(min(out_w, out_h) * 0.008))
        flat = flat[m:out_h - m, m:out_w - m]
    return flat


def rotate(arr: np.ndarray, angle: int) -> np.ndarray:
    turns = (angle // 90) % 4
    return {0: arr, 1: cv2.rotate(arr, cv2.ROTATE_90_CLOCKWISE),
            2: cv2.rotate(arr, cv2.ROTATE_180), 3: cv2.rotate(arr, cv2.ROTATE_90_COUNTERCLOCKWISE)}[turns]


def _flatten(channel: np.ndarray) -> np.ndarray:
    """Убирает тени и неравномерный свет: делим картинку на «фон» (размытую бумагу)."""
    # Фон считаем на уменьшенной копии — в десятки раз быстрее, а результат тот же.
    h, w = channel.shape
    k_scale = min(1.0, 400 / max(h, w))
    small = cv2.resize(channel, (max(1, round(w * k_scale)), max(1, round(h * k_scale))), interpolation=cv2.INTER_AREA)
    k = max(5, (min(small.shape) // 12) | 1)
    background = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    background = cv2.GaussianBlur(background, (0, 0), k / 4)
    background = cv2.resize(background, (w, h), interpolation=cv2.INTER_LINEAR)
    flat = channel.astype(np.float32) / np.maximum(background.astype(np.float32), 1) * 255
    return np.clip(flat, 0, 255).astype(np.uint8)


def _levels(arr: np.ndarray, strength: int) -> np.ndarray:
    """Контраст 0…4: растягиваем от «чёрного» до «белого» и затемняем текст."""
    if strength <= 0:
        return arr
    lo_pct = [0, 0.5, 2, 5, 9][strength]
    hi_pct = [100, 99.5, 97, 93, 88][strength]
    lo, hi = np.percentile(arr, [lo_pct, hi_pct])
    if hi - lo < 10:
        return arr
    out = (arr.astype(np.float32) - lo) / (hi - lo)
    out = np.clip(out, 0, 1) ** (1 + 0.15 * strength)  # гамма: средние тона темнее — текст жирнее
    return (out * 255).astype(np.uint8)


def _sharpen(arr: np.ndarray, strength: int) -> np.ndarray:
    if strength <= 0:
        return arr
    sigma = max(1.0, min(arr.shape[:2]) / 1200)
    blur = cv2.GaussianBlur(arr, (0, 0), sigma)
    amount = 0.5 * strength
    return cv2.addWeighted(arr, 1 + amount, blur, -amount, 0)


def process(rgb: np.ndarray, corners=None, rot: int = 0, mode: str = "doc",
            contrast: int = 2, sharpness: int = 1) -> np.ndarray:
    contrast = min(max(int(contrast), 0), 4)
    sharpness = min(max(int(sharpness), 0), 4)
    arr = warp(rgb, corners) if corners else rgb
    arr = rotate(arr, rot)
    if mode == "original":
        return _sharpen(arr, sharpness) if sharpness else arr
    if mode == "color":
        flat = cv2.merge([_flatten(c) for c in cv2.split(arr)])
        out = _sharpen(_levels(flat, contrast), sharpness)
        paper = out.min(axis=2) >= 225  # почти белое во всех каналах — это бумага
        out[paper] = 255
        return out
    gray = _flatten(cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY))
    if mode == "bw":
        # Тени уже убраны (_flatten), бумага почти белая — порог Оцу чисто отделяет текст от фона.
        # «Контраст» сдвигает порог: больше — текст жирнее, меньше — тоньше и меньше пятен.
        gray = cv2.GaussianBlur(_sharpen(gray, sharpness), (3, 3), 0)
        otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        _, bw = cv2.threshold(gray, min(max(otsu + (contrast - 2) * 12, 40), 235), 255, cv2.THRESH_BINARY)
        return bw
    return _whiten(_sharpen(_levels(gray, contrast), sharpness))


def _whiten(gray: np.ndarray) -> np.ndarray:
    """Делает бумагу идеально белой. Мелкий «шум» на фоне — главная причина тяжёлых PDF."""
    out = cv2.medianBlur(gray, 3)
    out[out >= 225] = 255
    return out


def fit(arr: np.ndarray, max_side: int) -> np.ndarray:
    h, w = arr.shape[:2]
    if max(h, w) <= max_side:
        return arr
    k = max_side / max(h, w)
    return cv2.resize(arr, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)
