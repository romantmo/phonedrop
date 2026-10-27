// PhoneDrop — «Сканер 2.0»: уголки листа, режимы, контраст, резкость, размер листа и вес PDF.
// Каждое фото загружается на сервер один раз. Дальше отправляются только настройки,
// а превью и PDF сервер делает из уже загруженного фото — так почти не тратится трафик.
"use strict";

window.PDScanner = (() => {
  const { $, el, toast, api } = PD;
  const ROLE = "phone";
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

  const CHOICES = {
    mode: [["color", "🎨 Цвет"], ["doc", "📄 Документ"], ["bw", "⚫ Ч/Б"], ["original", "📷 Оригинал"]],
    page_size: [["a4", "A4"], ["a5", "A5"], ["letter", "Letter"], ["auto", "По фото"]],
    weight: [["light", "Маленький"], ["normal", "Средний"], ["max", "Высокое качество"]],
  };
  const HINTS = {
    mode: {
      color: "Бумага белая, цвета сохраняются — для бланков с печатями и подписями.",
      doc: "Серый, контрастный — для обычных документов.",
      bw: "Чёрный текст на чисто белом — самый чёткий и самый лёгкий файл.",
      original: "Без обработки — только обрезка и поворот.",
    },
    weight: {
      light: "Около 150 КБ на страницу с текстом — для WhatsApp и почты.",
      normal: "Около 300–450 КБ на страницу — текст чёткий даже при увеличении.",
      max: "Около 0,8–1,3 МБ на страницу — для печати (300 dpi).",
    },
  };
  const DEFAULTS = { mode: "doc", contrast: 2, sharpness: 1, page_size: "a4", weight: "normal" };

  // Настройки запоминаются на этом телефоне (если браузер разрешает).
  let settings = { ...DEFAULTS };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem("pd-scan-settings") || "{}"));
  } catch { /* приватный режим — просто используем значения по умолчанию */ }
  function save() {
    try { localStorage.setItem("pd-scan-settings", JSON.stringify(settings)); } catch { /* не страшно */ }
  }

  function previewUrl(page, size) {
    const p = { corners: page.corners, rot: page.rot, mode: settings.mode,
      contrast: settings.contrast, sharpness: settings.sharpness, size };
    return `/s/${page.id}/preview?p=${encodeURIComponent(JSON.stringify(p))}`;
  }

  // ---------- панель настроек
  function renderSettings(box, onChange) {
    const seg = (key) => el("div", { class: "seg seg-" + key }, ...CHOICES[key].map(([value, label]) =>
      el("button", { type: "button", class: settings[key] === value ? "on" : "",
        onclick: () => { settings[key] = value; save(); renderSettings(box, onChange); onChange(key); } }, label)));
    const slider = (key, label, left, right) => {
      const input = el("input", { type: "range", min: "0", max: "4", step: "1", value: String(settings[key]),
        "aria-label": label });
      input.addEventListener("change", () => { settings[key] = Number(input.value); save(); onChange(key); });
      return el("label", { class: "slider" },
        el("span", { class: "slider-title" }, label),
        el("span", { class: "slider-row" }, el("small", {}, left), input, el("small", {}, right)));
    };
    const bw = settings.mode === "bw";
    box.replaceChildren(
      el("h4", {}, "Размер файла PDF"), seg("weight"),
      el("p", { class: "set-hint" }, bw ? "В режиме Ч/Б файл в любом случае крошечный — десятки КБ на страницу."
        : HINTS.weight[settings.weight] + (settings.weight === "light" ? " Ещё меньше — режим «Ч/Б»." : "")),
      el("h4", {}, "Режим"), seg("mode"), el("p", { class: "set-hint" }, HINTS.mode[settings.mode]),
      settings.mode === "original" ? null : slider("contrast", bw ? "Толщина текста" : "Контраст", "меньше", "больше"),
      slider("sharpness", "Резкость", "мягче", "чётче"),
      el("h4", {}, "Формат листа"), seg("page_size"));
  }

  // ---------- загрузка фото
  function upload(files, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f, f.name || "photo.jpg");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/scan/pages");
      xhr.setRequestHeader("X-PD-Role", ROLE);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
        if (xhr.status === 200) resolve(data.pages.map((p) => ({ ...p, auto: p.corners, corners: p.corners || FULL, rot: 0 })));
        else reject(new Error((data && data.detail) || `Ошибка ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Нет связи с сервером"));
      xhr.send(fd);
    });
  }

  function makePdf(pages, name) {
    return api(ROLE, "/api/scan/pdf", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pages: pages.map((p) => ({ id: p.id, corners: p.corners, rot: p.rot })),
        mode: settings.mode, contrast: settings.contrast, sharpness: settings.sharpness,
        page_size: settings.page_size, weight: settings.weight, name,
      }),
    });
  }

  // ---------- редактор страницы
  let page = null;
  let corners = null;
  let rot = 0;
  let resolveEditor = null;

  function drawCrop() {
    const pts = corners.map(([x, y]) => `${x},${y}`).join(" ");
    $("cropPoly").setAttribute("points", pts);
    // Затемняем всё, что вне листа.
    $("cropShade").setAttribute("d", `M0,0H1V1H0Z M${corners.map(([x, y]) => `${x},${y}`).join(" L")}Z`);
    document.querySelectorAll(".crop-handle").forEach((h, i) => {
      h.style.left = corners[i][0] * 100 + "%";
      h.style.top = corners[i][1] * 100 + "%";
    });
  }

  function showTab(result) {
    $("edTabCrop").classList.toggle("on", !result);
    $("edTabResult").classList.toggle("on", result);
    $("cropBox").hidden = result;
    $("edResult").hidden = !result;
    $("edSub").textContent = result ? "Так страница будет выглядеть в PDF" : "Перетащи уголки к краям листа";
    if (result) {
      const img = $("edResult");
      $("edLoading").hidden = false;
      img.onload = img.onerror = () => { $("edLoading").hidden = true; };
      img.src = previewUrl({ id: page.id, corners, rot }, 1200);
    }
  }

  function bindHandles() {
    const box = $("cropBox");
    box.querySelectorAll(".crop-handle").forEach((h) => h.remove());
    corners.forEach((_, i) => {
      const handle = el("div", { class: "crop-handle", role: "slider", "aria-label": `Уголок ${i + 1}` });
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("active");
        const rect = $("edImg").getBoundingClientRect();
        const move = (ev) => {
          const x = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1);
          const y = Math.min(Math.max((ev.clientY - rect.top) / rect.height, 0), 1);
          corners[i] = [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
          drawCrop();
        };
        const up = () => {
          handle.classList.remove("active");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      });
      box.append(handle);
    });
  }

  function openEditor(target, index, total) {
    page = target;
    corners = page.corners.map((p) => [...p]);
    rot = page.rot;
    $("edTitle").textContent = `Страница ${index + 1} из ${total}`;
    $("edAuto").disabled = !page.auto;
    const img = $("edImg");
    img.src = page.image_url;
    $("scanEditor").hidden = false;
    bindHandles();
    drawCrop();
    showTab(false);
    // Кнопка «Назад» на Android закрывает редактор, а не весь инструмент.
    history.pushState(Object.assign({}, history.state, { ed: 1 }), "");
    return new Promise((resolve) => { resolveEditor = resolve; });
  }

  function closeEditor(apply) {
    if (apply) {
      page.corners = corners;
      page.rot = rot;
    }
    $("scanEditor").hidden = true;
    $("edResult").removeAttribute("src");
    if (resolveEditor) resolveEditor(apply);
    resolveEditor = null;
  }

  const leave = () => { if (history.state && history.state.ed) history.back(); else closeEditor(true); };
  $("edDone").addEventListener("click", leave);
  $("edBack").addEventListener("click", leave);
  window.addEventListener("popstate", () => { if (!$("scanEditor").hidden) closeEditor(true); });
  $("edTabCrop").addEventListener("click", () => showTab(false));
  $("edTabResult").addEventListener("click", () => showTab(true));
  $("edAuto").addEventListener("click", () => {
    if (!page.auto) return toast("Лист на фото не найден — поставь уголки вручную", true);
    corners = page.auto.map((p) => [...p]);
    drawCrop();
    if (!$("edResult").hidden) showTab(true);
  });
  $("edFull").addEventListener("click", () => {
    corners = FULL.map((p) => [...p]);
    drawCrop();
    if (!$("edResult").hidden) showTab(true);
  });
  $("edRotate").addEventListener("click", () => {
    rot = (rot + 90) % 360;
    showTab(true);  // поворот виден только на результате
    toast(`Поворот: ${rot}°`);
  });

  return { settings: () => settings, renderSettings, previewUrl, upload, makePdf, openEditor };
})();
