// Подпись для «Подписать PDF»: нарисовать пальцем или мышкой и поставить на страницу.
//
// Как это работает (для чайника):
// - Подпись рисуется на «холсте» (canvas) и сохраняется картинкой PNG с прозрачным фоном.
// - На телефоне её можно запомнить (хранится только на этом устройстве, на сервер отдельно не уходит),
//   чтобы в следующий раз не рисовать заново. На компьютере по умолчанию не запоминаем — он может быть чужим.
// - Потом подпись перетаскивают по странице, размер — ползунком. На сервер уходит PDF, картинка подписи
//   и место: доли страницы (x, y — левый верхний угол подписи, w — ширина).
"use strict";

window.PDSign = (() => {
  const { el, toast } = PD;
  const KEY = "pd-signature";
  const ON_PC = (document.body.dataset.role || "phone") === "pc";
  let dataUrl = null;
  try { dataUrl = localStorage.getItem(KEY); } catch { /* приватный режим */ }

  function overlay(title, ...body) {
    const node = el("div", { class: "sg-ov", role: "dialog", "aria-label": title },
      el("div", { class: "sg-box" }, el("h3", { class: "sg-title" }, title), ...body));
    document.body.append(node);
    return node;
  }

  // ------------------------------------------------ нарисовать подпись
  function draw() {
    return new Promise((resolve) => {
      const canvas = el("canvas", { class: "sg-pad", "aria-label": tx("Поле для подписи") });
      const remember = el("input", { type: "checkbox" });
      remember.checked = !ON_PC;
      let ctx = null;
      let drawing = false;
      let last = null;
      let empty = true;

      const finish = (value) => { node.remove(); resolve(value); };
      const clear = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        empty = true;
      };
      const point = (e) => {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
      };
      canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drawing = true;
        last = point(e);
        ctx.beginPath();
        ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        empty = false;
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!drawing) return;
        e.preventDefault();
        const p = point(e);
        const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last = p;
      });
      for (const ev of ["pointerup", "pointercancel"]) canvas.addEventListener(ev, () => { drawing = false; });

      const done = () => {
        if (empty) return toast(tx("Подпись пустая — нарисуй её ещё раз"), true);
        const url = trim(canvas);
        if (!url) return toast(tx("Подпись пустая — нарисуй её ещё раз"), true);
        try {
          if (remember.checked) localStorage.setItem(KEY, url);
          else localStorage.removeItem(KEY);
        } catch { /* не важно */ }
        dataUrl = url;
        finish(url);
      };

      const node = overlay(tx("Нарисуй подпись"),
        el("p", { class: "sg-hint" }, ON_PC ? tx("Распишись мышкой в рамке.") : tx("Распишись пальцем в рамке. Удобнее держать телефон горизонтально.")),
        el("div", { class: "sg-pad-wrap" }, canvas, el("div", { class: "sg-line" })),
        el("label", { class: "sg-remember" }, remember, tx(" Запомнить подпись на этом устройстве")),
        el("div", { class: "sg-actions" },
          el("button", { type: "button", class: "btn", onclick: clear }, tx("Очистить")),
          el("button", { type: "button", class: "btn", onclick: () => finish(null) }, tx("Отмена")),
          el("button", { type: "button", class: "btn primary", onclick: done }, tx("Готово"))));

      // Размер холста — по фактической ширине на экране, с учётом плотности пикселей.
      requestAnimationFrame(() => {
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const r = canvas.getBoundingClientRect();
        canvas.width = Math.round(r.width * dpr);
        canvas.height = Math.round(r.height * dpr);
        ctx = canvas.getContext("2d");
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.strokeStyle = ctx.fillStyle = "#13235b";  // тёмно-синие «чернила»
        ctx.lineWidth = Math.max(2, 2.6 * dpr);
      });
    });
  }

  // Обрезаем пустые края, чтобы подпись ставилась ровно своей частью.
  function trim(canvas) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const pad = 4;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  // ------------------------------------------------ поставить на страницу
  function place(pageUrl, current) {
    return new Promise(async (resolve) => {
      if (!dataUrl && !(await draw())) return resolve(null);
      const pos = Object.assign({ x: 0.55, y: 0.78, w: 0.32 }, current || {});
      const page = el("img", { class: "sg-page", src: pageUrl, alt: "", draggable: "false" });
      const sig = el("img", { class: "sg-sig", src: dataUrl, alt: tx("Подпись"), draggable: "false" });
      const stage = el("div", { class: "sg-stage" }, page, sig);
      const size = el("input", { type: "range", min: "8", max: "70", value: String(Math.round(pos.w * 100)),
        "aria-label": tx("Размер подписи") });

      const clamp = () => {
        const sh = sig.offsetHeight / Math.max(1, stage.clientHeight);
        pos.x = Math.min(Math.max(0, pos.x), Math.max(0, 1 - pos.w));
        pos.y = Math.min(Math.max(0, pos.y), Math.max(0, 1 - sh));
      };
      const paint = () => {
        sig.style.width = pos.w * 100 + "%";
        clamp();
        sig.style.left = pos.x * 100 + "%";
        sig.style.top = pos.y * 100 + "%";
      };
      size.addEventListener("input", () => { pos.w = Number(size.value) / 100; paint(); });

      // Перетаскивание подписи; нажатие на страницу переносит подпись туда.
      let drag = null;
      stage.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        if (e.target !== sig) {
          pos.x = (e.clientX - r.left) / r.width - pos.w / 2;
          pos.y = (e.clientY - r.top) / r.height - sig.offsetHeight / r.height / 2;
          paint();
        }
        stage.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y, w: r.width, h: r.height };
      });
      stage.addEventListener("pointermove", (e) => {
        if (!drag) return;
        pos.x = drag.px + (e.clientX - drag.x) / drag.w;
        pos.y = drag.py + (e.clientY - drag.y) / drag.h;
        paint();
      });
      for (const ev of ["pointerup", "pointercancel"]) stage.addEventListener(ev, () => { drag = null; });

      const finish = (value) => { node.remove(); resolve(value); };
      const node = overlay(tx("Перетащи подпись на нужное место"),
        stage,
        el("label", { class: "sg-size" }, tx("Размер"), size),
        el("div", { class: "sg-actions" },
          el("button", { type: "button", class: "btn", onclick: async () => {
            node.hidden = true;
            const url = await draw();
            node.hidden = false;
            if (url) { sig.src = url; requestAnimationFrame(paint); }
          } }, tx("Другая подпись")),
          el("button", { type: "button", class: "btn", onclick: () => finish(null) }, tx("Отмена")),
          el("button", { type: "button", class: "btn primary", onclick: () => {
            clamp();
            finish({ x: +pos.x.toFixed(4), y: +pos.y.toFixed(4), w: +pos.w.toFixed(4) });
          } }, tx("Готово"))));
      const ready = () => requestAnimationFrame(paint);
      page.addEventListener("load", ready);
      sig.addEventListener("load", ready);
      if (page.complete) ready();
    });
  }

  // Картинка подписи для отправки на сервер (data: URL → файл, без fetch — его не пускает CSP).
  function blob() {
    const [head, b64] = dataUrl.split(",");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: head.slice(5, head.indexOf(";")) || "image/png" });
  }

  return { place, draw, blob, image: () => dataUrl };
})();
