// PhoneDrop — «Сканер 2.0»: уголки листа, вид страниц (режим, контраст, резкость), размер PDF.
// Каждое фото загружается на сервер один раз. Дальше отправляются только настройки,
// а превью и PDF сервер делает из уже загруженного фото — так почти не тратится трафик.
"use strict";

window.PDScanner = (() => {
  const { $, el, toast, api } = PD;
  const ROLE = "phone";
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

  const MODES = [["color", "Цвет"], ["doc", "Документ"], ["bw", "Ч/Б"], ["original", "Оригинал"]];
  const MODE_NAME = Object.fromEntries(MODES);
  const WEIGHTS = [["light", "Маленький"], ["normal", "Средний"], ["max", "Высокое качество"]];
  const WEIGHT_HINT = {
    light: "≈ 150 КБ на страницу — для WhatsApp и почты",
    normal: "≈ 300–450 КБ на страницу",
    max: "≈ 1 МБ на страницу — для печати",
  };
  const PAGE_SIZES = [["a4", "A4"], ["a5", "A5"], ["letter", "Letter"], ["auto", "По размеру фото"]];
  const DEFAULTS = { mode: "doc", contrast: 2, sharpness: 1, page_size: "a4", weight: "normal" };

  // Настройки запоминаются на этом телефоне (если браузер разрешает).
  const settings = { ...DEFAULTS };
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

  // Маленькое меню снизу экрана с вариантами.
  function choose(title, options, current) {
    return new Promise((resolve) => {
      const close = (v) => { backdrop.remove(); resolve(v); };
      const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => e.target === backdrop && close(null) },
        el("div", { class: "sheet" }, el("h3", {}, title),
          ...options.map(([value, label]) => el("button", { type: "button", onclick: () => close(value) },
            el("span", {}, label), value === current ? el("span", { class: "sheet-online" }, "✓") : null)),
          el("button", { type: "button", class: "cancel", onclick: () => close(null) }, "Отмена")));
      document.body.append(backdrop);
    });
  }

  // ---------- настройки на главном экране сканера: только самое нужное
  function renderSettings(box, onChange, onOpenLook) {
    const lookText = settings.mode === "original" ? MODE_NAME.original
      : `${MODE_NAME[settings.mode]} · контраст ${settings.contrast} · резкость ${settings.sharpness}`;
    const sizeName = PAGE_SIZES.find(([v]) => v === settings.page_size)?.[1] || "A4";
    box.replaceChildren(
      el("h4", {}, "Размер PDF"),
      el("div", { class: "seg seg-weight" }, ...WEIGHTS.map(([value, label]) =>
        el("button", { type: "button", class: settings.weight === value ? "on" : "", onclick: () => {
          settings.weight = value; save(); renderSettings(box, onChange, onOpenLook); onChange("weight");
        } }, label))),
      el("p", { class: "set-hint" }, settings.mode === "bw" ? "Ч/Б — всегда крошечный файл, десятки КБ на страницу"
        : WEIGHT_HINT[settings.weight]),
      el("button", { type: "button", class: "set-row", onclick: onOpenLook },
        el("span", { class: "set-ico" }, "🎨"),
        el("span", { class: "set-text" }, el("b", {}, "Вид страниц"), el("small", {}, lookText)),
        el("span", { class: "set-arrow" }, "›")),
      el("button", { type: "button", class: "set-row", onclick: async () => {
        const value = await choose("Формат листа", PAGE_SIZES, settings.page_size);
        if (!value) return;
        settings.page_size = value; save(); renderSettings(box, onChange, onOpenLook); onChange("page_size");
      } },
        el("span", { class: "set-ico" }, "📄"),
        el("span", { class: "set-text" }, el("b", {}, "Формат листа"), el("small", {}, sizeName)),
        el("span", { class: "set-arrow" }, "›")));
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

  // ---------- редактор: все страницы, большое превью
  let pages = [];
  let index = 0;
  let tab = "crop";
  let corners = null;
  let rot = 0;
  let resolveEditor = null;
  let lookTimer = null;
  let previewSeq = 0;

  const current = () => pages[index];

  function keepPage() {  // сохраняем уголки и поворот текущей страницы
    if (!current() || !corners) return;  // редактор только открылся — сохранять ещё нечего
    current().corners = corners;
    current().rot = rot;
  }

  function drawCrop() {
    $("cropPoly").setAttribute("points", corners.map(([x, y]) => `${x},${y}`).join(" "));
    // Затемняем всё, что вне листа.
    $("cropShade").setAttribute("d", `M0,0H1V1H0Z M${corners.map(([x, y]) => `${x},${y}`).join(" L")}Z`);
    document.querySelectorAll(".crop-handle").forEach((h, i) => {
      h.style.left = corners[i][0] * 100 + "%";
      h.style.top = corners[i][1] * 100 + "%";
    });
  }

  // Превью грузим «в фоне» и подменяем, только когда новое готово, — без мигания.
  function refreshPreview() {
    const seq = ++previewSeq;
    $("edLoading").hidden = false;
    const next = new Image();
    next.onload = () => {
      if (seq !== previewSeq) return;
      $("edResult").src = next.src;
      $("edLoading").hidden = true;
    };
    next.onerror = () => { if (seq === previewSeq) { $("edLoading").hidden = true; toast("Не удалось обновить превью", true); } };
    next.src = previewUrl({ id: current().id, corners, rot }, 1400);
  }

  function renderLookTools() {
    const box = $("edLookTools");
    const slider = (key, label) => {
      const input = el("input", { type: "range", min: "0", max: "4", step: "1", value: String(settings[key]),
        "aria-label": label });
      // Пока тянешь ползунок — превью обновляется само (с небольшой паузой).
      input.addEventListener("input", () => {
        settings[key] = Number(input.value);
        clearTimeout(lookTimer);
        lookTimer = setTimeout(() => { save(); refreshPreview(); }, 250);
      });
      return el("label", { class: "ed-slider" }, el("span", {}, label), input);
    };
    box.replaceChildren(
      el("div", { class: "ed-modes" }, ...MODES.map(([value, label]) =>
        el("button", { type: "button", class: settings.mode === value ? "on" : "", onclick: () => {
          settings.mode = value; save(); renderLookTools(); refreshPreview();
        } }, label))),
      settings.mode === "original" ? null : slider("contrast", settings.mode === "bw" ? "Толщина" : "Контраст"),
      slider("sharpness", "Резкость"),
      el("p", { class: "ed-note" }, "Вид применяется ко всем страницам"));
  }

  function showTab(name) {
    tab = name;
    const look = name === "look";
    $("edTabCrop").classList.toggle("on", !look);
    $("edTabLook").classList.toggle("on", look);
    $("cropBox").hidden = look;
    $("edResult").hidden = !look;
    $("edBadge").hidden = !look;
    $("edCropTools").hidden = look;
    $("edLookTools").hidden = !look;
    if (look) { renderLookTools(); refreshPreview(); } else $("edLoading").hidden = true;
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

  function showPage(i) {
    keepPage();
    index = Math.min(Math.max(i, 0), pages.length - 1);
    corners = current().corners.map((p) => [...p]);
    rot = current().rot;
    $("edTitle").textContent = `${index + 1} / ${pages.length}`;
    $("edPrev").disabled = index === 0;
    $("edNext").disabled = index === pages.length - 1;
    $("edAuto").disabled = !current().auto;
    $("edImg").src = current().image_url;
    $("edResult").removeAttribute("src");
    bindHandles();
    drawCrop();
    showTab(tab);
  }

  // Открыть редактор: startTab — "crop" (обрезка) или "look" (вид страниц).
  function openEditor(list, start, startTab = "crop") {
    pages = list.filter((p) => !p.uploading);
    if (!pages.length) return Promise.resolve(false);
    index = Math.max(0, pages.indexOf(list[start]));
    tab = startTab;
    corners = null;
    $("scanEditor").hidden = false;
    showPage(index);
    // Кнопка «Назад» на Android закрывает редактор, а не весь инструмент.
    history.pushState(Object.assign({}, history.state, { ed: 1 }), "");
    return new Promise((resolve) => { resolveEditor = resolve; });
  }

  function closeEditor() {
    keepPage();
    clearTimeout(lookTimer);
    save();
    $("scanEditor").hidden = true;
    $("edResult").removeAttribute("src");
    pages = [];
    if (resolveEditor) resolveEditor(true);
    resolveEditor = null;
  }

  const leave = () => { if (history.state && history.state.ed) history.back(); else closeEditor(); };
  $("edDone").addEventListener("click", leave);
  $("edBack").addEventListener("click", leave);
  window.addEventListener("popstate", () => { if (!$("scanEditor").hidden) closeEditor(); });
  $("edPrev").addEventListener("click", () => showPage(index - 1));
  $("edNext").addEventListener("click", () => showPage(index + 1));
  $("edTabCrop").addEventListener("click", () => showTab("crop"));
  $("edTabLook").addEventListener("click", () => showTab("look"));
  $("edAuto").addEventListener("click", () => {
    corners = current().auto.map((p) => [...p]);
    drawCrop();
  });
  $("edFull").addEventListener("click", () => {
    corners = FULL.map((p) => [...p]);
    drawCrop();
  });
  $("edRotate").addEventListener("click", () => {
    rot = (rot + 90) % 360;
    showTab("look");  // поворот виден на готовой странице
  });

  // Удерживаешь палец на превью — видно исходное фото («до»), отпускаешь — снова результат.
  const result = $("edResult");
  let shown = null;
  result.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    shown = result.src;
    result.src = current().image_url;
    result.classList.add("before");
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    result.addEventListener(ev, () => {
      if (shown) { result.src = shown; shown = null; result.classList.remove("before"); }
    });
  }
  result.addEventListener("contextmenu", (e) => e.preventDefault());

  return { renderSettings, previewUrl, upload, makePdf, openEditor };
})();
