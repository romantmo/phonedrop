// PhoneDrop — «Инструменты» (телефон и компьютер): сканер документов и конвертеры.
// Файлы отправляются на наш сервер, там их обрабатывает отдельный изолированный конвертер,
// результат хранится 30 минут — успеть поделиться, скачать или отправить на компьютер.
"use strict";

window.PDTools = (() => {
  const { $, el, toast, api, fmtSize, canShareFiles, shareFiles, prefetchShare } = PD;
  const ROLE = document.body.dataset.role || "phone";  // «pc» — на компьютере
  const ON_PC = ROLE === "pc";
  const MAX_FILES = 50;
  const OFFICE_ACCEPT = ".doc,.docx,.docm,.odt,.rtf,.xls,.xlsx,.xlsm,.ods,.csv,.ppt,.pptx,.pps,.ppsx,.odp";
  const IMAGE_ACCEPT = "image/*,.heic,.heif";

  const TOOLS = [
    {
      id: "scan", op: "scan", icon: "📷", title: "Сканер документов",
      sub: "Фото страниц → ровный PDF",
      hint: "Сфотографируй страницы — лист найдётся сам. Нажми на страницу, чтобы поправить.",
      camera: true, scanner: true, accept: IMAGE_ACCEPT, multi: true, arrange: true, rotate: true, min: 1,
      action: "Сделать PDF",
    },
    {
      id: "share", custom: "share", phoneOnly: true, icon: "🌍", title: "Отправить по ссылке",
      sub: "Человеку в любой стране — ссылка или код",
      hint: "Файлы до 10 ГБ. Получатель откроет ссылку или введёт код на сайте — без регистрации.",
    },
    {
      id: "office", op: "office-pdf", icon: "📄", title: "Документ → PDF",
      sub: "Word, Excel, PowerPoint",
      hint: "Выбери файл Word, Excel или PowerPoint — получишь PDF, который откроется на любом устройстве.",
      accept: OFFICE_ACCEPT, multi: false, min: 1, action: "Превратить в PDF",
    },
    {
      id: "compresspdf", op: "compress-pdf", icon: "🪶", title: "Сжать PDF",
      sub: "Тяжёлый PDF → лёгкий",
      hint: "Например, скан из почты на 20 МБ. Картинки внутри пережимаются, текст остаётся текстом — его можно выделять и искать.",
      accept: "application/pdf,.pdf", multi: false, min: 1, action: "Сжать PDF",
      options: { key: "preset", def: "normal", choices: [["light", "Маленький"], ["normal", "Средний"], ["max", "Высокое качество"]] },
    },
    {
      id: "merge", op: "merge-pdf", icon: "📎", title: "Объединить PDF",
      sub: "Несколько PDF → один",
      hint: "Выбери два или больше PDF и расставь в нужном порядке.",
      accept: "application/pdf,.pdf", multi: true, arrange: true, min: 2, action: "Объединить",
    },
    {
      id: "pdfimg", op: "pdf-images", icon: "🖼", title: "PDF → картинки",
      sub: "Каждая страница — отдельный JPG",
      hint: "Удобно, чтобы отправить страницу документа как фото.",
      accept: "application/pdf,.pdf", multi: false, min: 1, action: "Сделать картинки",
    },
    {
      id: "compress", op: "images-jpg", icon: "🗜", title: "Сжать фото / HEIC → JPG",
      sub: "Меньше размер, без геолокации",
      hint: "Фото станут легче для почты и мессенджеров. Из них удаляются геолокация и данные телефона.",
      accept: IMAGE_ACCEPT, multi: true, min: 1,
      options: { key: "preset", def: "email", choices: [["email", "Для почты"], ["small", "Сильнее"], ["original", "Только в JPG"]] },
      action: "Сжать",
    },
  ];

  let tool = null;
  let items = [];      // [{ file, rot, preview }]
  let results = [];
  let option = null;
  let busy = false;
  let uploading = 0;   // сколько фото сейчас загружается (сканер)

  const ext = (name) => (name.includes(".") ? name.split(".").pop() : "file").slice(0, 4);
  const isImage = (f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);

  // ---------- главный экран инструментов
  function renderHome(container, onOpen) {
    container.replaceChildren(
      el("div", { class: "tools-grid" }, ...TOOLS.filter((t) => !(t.phoneOnly && ON_PC)).map((t) =>
        el("button", { class: "tool-card", type: "button", onclick: () => onOpen(t.id) },
          el("span", { class: "tool-emoji" }, t.icon),
          el("b", {}, t.title),
          el("span", { class: "tool-sub" }, t.sub)))),
      el("p", { class: "tools-note" },
        "🔒 Файлы обрабатываются на твоём сервере PhoneDrop, не на чужих сайтах. Результат хранится 30 минут и удаляется."));
  }

  // ---------- экран инструмента
  function open(id) {
    const next = TOOLS.find((t) => t.id === id);
    if (!next) return false;
    if (!tool || tool.id !== id) reset(next);
    return true;
  }

  function reset(next) {
    items.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    tool = next;
    items = [];
    results = [];
    option = tool.options ? tool.options.def : null;
    $("toolResults").hidden = true;
    $("toolIcon").textContent = tool.icon;
    $("toolTitle").textContent = tool.title;
    $("toolSub").textContent = tool.sub;
    $("toolHint").textContent = tool.hint + (ON_PC ? " Файлы можно перетащить мышкой в это окно или вставить Ctrl+V." : "");
    // «Посылка» — свой экран (shares.js), обычные части инструмента прячем.
    const custom = !!tool.custom;
    for (const id of ["toolFiles", "toolAdd", "toolFoot"]) $(id).hidden = custom;
    $("shareBox").hidden = !custom;
    if (custom) { PDShares.mount($("shareBox")); }
    $("toolCamera").hidden = !tool.camera || ON_PC;
    $("toolPick").textContent = tool.camera && !ON_PC ? "🖼 Галерея" : tool.multi ? "📂 Выбрать файлы" : "📂 Выбрать файл";
    $("toolSendPc").textContent = ON_PC ? "📱 На телефон" : "💻 На компьютер";
    const pick = $("toolPickInput");
    pick.accept = tool.accept || "";
    pick.multiple = tool.multi;
    $("toolRun").textContent = tool.action;
    $("scanSettings").hidden = !tool.scanner;
    if (tool.scanner) renderScanSettings();
    renderOptions();
    render();
  }

  function renderScanSettings() {
    PDScanner.renderSettings($("scanSettings"), () => staleResults(), () => {
      const first = items.findIndex((it) => !it.uploading);
      if (first < 0) return toast("Сначала добавь страницу", true);
      editPage(first, "look");
    });
  }

  function renderOptions() {
    const box = $("toolOptions");
    box.hidden = !tool.options;
    if (!tool.options) return;
    box.replaceChildren(...tool.options.choices.map(([value, label]) =>
      el("button", { type: "button", class: value === option ? "on" : "",
        onclick: () => { option = value; renderOptions(); staleResults(); } }, label)));
  }

  function addFiles(list) {
    let files = [...list];
    if (!files.length) return;
    // Перетащили или вставили не тот тип файла — отсеиваем сразу, без похода на сервер.
    const ok = (f) => tool.accept.split(",").some((a) => a.startsWith(".")
      ? f.name.toLowerCase().endsWith(a) : a.endsWith("/*") ? f.type.startsWith(a.slice(0, -1)) : f.type === a);
    if (files.some((f) => !ok(f))) {
      toast(tool.accept === IMAGE_ACCEPT ? "Здесь можно использовать только фото" : "Этот тип файла здесь не подходит", true);
      files = files.filter(ok);
      if (!files.length) return;
    }
    if (tool.scanner) return uploadScan(files);
    if (!tool.multi) {
      items.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      items = [];
      files = files.slice(0, 1);
    }
    for (const file of files) {
      if (items.length >= MAX_FILES) { toast(`Не больше ${MAX_FILES} файлов за раз`, true); break; }
      items.push({ file, rot: 0, preview: isImage(file) ? URL.createObjectURL(file) : null });
    }
    staleResults();
    render();
  }

  // Сканер: каждое фото сразу загружается на сервер (пачками до 20).
  async function uploadScan(files) {
    files = files.slice(0, Math.max(0, MAX_FILES - items.length));
    for (let start = 0; start < files.length; start += 20) {
      const batch = files.slice(start, start + 20);
      const holders = batch.map((f) => ({ uploading: true, name: f.name || "фото", progress: 0 }));
      items.push(...holders);
      uploading += batch.length;
      staleResults();
      render();
      try {
        const pages = await PDScanner.upload(batch, (p) => {
          holders.forEach((h) => (h.progress = p));
          document.querySelectorAll(".page-card.loading .page-status").forEach((n) => (n.textContent =
            p < 1 ? `Загрузка ${Math.round(p * 100)}%` : "Ищу лист на фото…"));
        });
        holders.forEach((h, i) => Object.assign(h, pages[i], { uploading: false }));
      } catch (e) {
        toast(e.message, true);
        items = items.filter((it) => !holders.includes(it));
      } finally {
        uploading -= batch.length;
        render();
      }
    }
  }

  // Редактор страниц: обрезка и вид (режим, контраст, резкость) с большим превью.
  async function editPage(i, tab = "crop") {
    const item = items[i];
    if (!item || item.uploading) return;
    await PDScanner.openEditor(items, i, tab);
    staleResults();
    renderScanSettings();
    render();
  }

  function staleResults() {
    results = [];
    $("toolResults").hidden = true;
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    staleResults();
    render();
  }

  function thumb(item, i) {
    const box = el("div", { class: "tf-thumb" });
    if (tool.scanner) {
      if (item.uploading) {
        box.append(el("span", { class: "tf-spinner" }));
      } else {
        box.classList.add("editable");
        box.addEventListener("click", () => editPage(i));
        box.append(el("img", { src: PDScanner.previewUrl(item, 240), alt: "", loading: "lazy" }));
      }
      return box;
    }
    if (item.preview) {
      const img = el("img", { src: item.preview, alt: "", class: "rot-" + item.rot });
      // HEIC браузер показать не умеет — тогда просто значок.
      img.addEventListener("error", () => box.replaceChildren(el("span", { class: "tf-ext" }, ext(item.file.name))));
      box.append(img);
    } else {
      box.append(el("span", { class: "tf-ext" }, ext(item.file.name)));
    }
    return box;
  }

  function removeItem(i) {
    const item = items[i];
    if (item.preview) URL.revokeObjectURL(item.preview);
    items.splice(i, 1);
    staleResults();
    render();
  }

  // Сканер: страницы — плитками 2 в ряд, как в приложениях-сканерах.
  function pageCard(item, i) {
    const busyItem = item.uploading;
    return el("div", { class: "page-card" + (busyItem ? " loading" : "") },
      el("button", { type: "button", class: "page-thumb", disabled: busyItem, "aria-label": `Обрезать страницу ${i + 1}`,
        onclick: () => editPage(i) },
        busyItem ? el("span", { class: "tf-spinner" })
          : el("img", { src: PDScanner.previewUrl(item, 360), alt: "", loading: "lazy" }),
        el("span", { class: "page-num" }, String(i + 1)),
        busyItem ? el("span", { class: "page-status" }, "Загрузка…")
          : el("span", { class: "page-status" }, "✂️ Обрезать")),
      el("div", { class: "page-ctrl" },
        el("button", { type: "button", "aria-label": "Повернуть", disabled: busyItem,
          onclick: () => { item.rot = (item.rot + 90) % 360; staleResults(); render(); } }, "⟳"),
        el("button", { type: "button", "aria-label": "Раньше", disabled: i === 0, onclick: () => move(i, -1) }, "←"),
        el("button", { type: "button", "aria-label": "Позже", disabled: i === items.length - 1, onclick: () => move(i, 1) }, "→"),
        el("button", { type: "button", class: "del", "aria-label": "Убрать", onclick: () => removeItem(i) }, "✕")));
  }

  function render() {
    const list = $("toolFiles");
    list.classList.toggle("pages", !!tool.scanner && items.length > 0);
    list.replaceChildren(...items.map((item, i) => tool.scanner ? pageCard(item, i) :
      el("div", { class: "tf-item" },
        tool.arrange ? el("span", { class: "tf-num" }, String(i + 1)) : null,
        thumb(item, i),
        el("div", { class: "tf-info" },
          el("div", { class: "tf-name" }, item.file.name),
          el("div", { class: "tf-size" }, fmtSize(item.file.size))),
        el("div", { class: "tf-ctrl" },
          tool.rotate ? el("button", { type: "button", "aria-label": "Повернуть", title: "Повернуть",
            onclick: () => { item.rot = (item.rot + 90) % 360; staleResults(); render(); } }, "⟳") : null,
          tool.arrange && i > 0 ? el("button", { type: "button", "aria-label": "Выше", onclick: () => move(i, -1) }, "↑") : null,
          tool.arrange && i < items.length - 1 ? el("button", { type: "button", "aria-label": "Ниже", onclick: () => move(i, 1) }, "↓") : null,
          el("button", { type: "button", class: "del", "aria-label": "Убрать", onclick: () => removeItem(i) }, "✕")))));
    if (!items.length) {
      list.append(el("div", { class: "tf-empty" }, tool.camera ? "Пока нет страниц" : "Файл ещё не выбран"));
    }
    if (tool.camera) $("toolCamera").textContent = "📷 Камера";
    const run = $("toolRun");
    run.disabled = busy || uploading > 0 || items.length < tool.min;
    run.textContent = busy ? "Обрабатываю…" : items.length && items.length < tool.min
      ? `Нужно ещё ${tool.min - items.length}` : tool.action;
  }

  // ---------- запуск
  function scanName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `Скан ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  }

  async function runScan() {
    busy = true;
    staleResults();
    render();
    const bar = $("toolProgress");
    bar.hidden = false;
    bar.classList.add("working");
    $("toolRun").textContent = "Собираю PDF…";
    try {
      const data = await PDScanner.makePdf(items, scanName());
      results = data.results;
      showResults(data.ttl_min);
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
      bar.hidden = true;
      bar.classList.remove("working");
      render();
    }
  }

  function run() {
    if (busy || uploading || items.length < tool.min) return;
    if (tool.scanner) return runScan();
    const fd = new FormData();
    for (const item of items) fd.append("files", item.file, item.file.name);
    if (tool.options) fd.append(tool.options.key, option);
    if (tool.rotate) fd.append("rotations", items.map((i) => i.rot).join(","));
    if (tool.op === "images-pdf") fd.append("name", scanName());
    busy = true;
    staleResults();
    render();
    const bar = $("toolProgress");
    const fill = bar.firstElementChild;
    bar.hidden = false;
    bar.classList.remove("working");
    fill.style.width = "0%";
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/tools/${tool.op}`);
    xhr.setRequestHeader("X-PD-Role", ROLE);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      fill.style.width = Math.round((e.loaded / e.total) * 100) + "%";
      if (e.loaded === e.total) { bar.classList.add("working"); $("toolRun").textContent = "Конвертирую…"; }
    };
    const done = () => { busy = false; bar.hidden = true; render(); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      done();
      if (xhr.status !== 200) {
        toast((data && data.detail) || `Ошибка ${xhr.status}`, true);
        return;
      }
      results = data.results;
      showResults(data.ttl_min);
    };
    xhr.onerror = () => { done(); toast("Нет связи с сервером", true); };
    xhr.send(fd);
  }

  function showResults(ttl) {
    prefetchShare(results);  // скачиваем заранее, чтобы «Поделиться» открылось сразу
    const list = $("toolResultsList");
    list.replaceChildren(...results.map((r) =>
      el("div", { class: "tr-item" },
        r.mime.startsWith("image/")
          ? el("img", { class: "tr-thumb", src: r.url, alt: "" })
          : el("div", { class: "tr-thumb tf-ext" }, ext(r.name)),
        el("div", { class: "tf-info" },
          el("div", { class: "tf-name" }, r.name),
          el("div", { class: "tf-size" }, fmtSize(r.size))),
        el("div", { class: "tr-links" },
          r.viewable ? el("a", { href: r.url, target: "_blank", rel: "noopener" }, "Открыть") : null,
          el("a", { href: r.download_url, download: r.name }, "Скачать")))));
    $("toolShareAll").hidden = !canShareFiles;
    $("toolShareAll").textContent = results.length > 1 ? `📤 Поделиться (${results.length})` : "📤 Поделиться";
    let note = `Файлы хранятся на сервере ${ttl} минут, потом удаляются.`;
    if (tool.op === "compress-pdf" && items[0] && results[0]) {
      const before = items[0].file.size;
      const after = results[0].size;
      note = (after < before
        ? `Было ${fmtSize(before)} → стало ${fmtSize(after)} (−${Math.round((1 - after / before) * 100)}%). `
        : "Меньше не получилось — этот PDF уже сжат. ") + note;
    }
    $("toolNote").textContent = note;
    $("toolResults").hidden = false;
    requestAnimationFrame(() => $("toolResults").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // ---------- «На компьютер»
  function chooseChat(chats) {
    return new Promise((resolve) => {
      const close = (value) => { backdrop.remove(); resolve(value); };
      const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => e.target === backdrop && close(null) },
        el("div", { class: "sheet" },
          el("h3", {}, "На какой компьютер?"),
          ...chats.map((c) => el("button", { type: "button", onclick: () => close(c) },
            el("span", {}, c.label), c.pc_online ? el("span", { class: "sheet-online" }, "в сети") : null)),
          el("button", { type: "button", class: "cancel", onclick: () => close(null) }, "Отмена")));
      document.body.append(backdrop);
    });
  }

  async function sendToPc() {
    if (ON_PC) {  // с компьютера — в его чат с телефоном
      try {
        await api(ROLE, "/api/tools/send", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: results.map((r) => r.id) }),
        });
        toast("Отправлено на телефон");
      } catch (e) {
        toast(e.message, true);
      }
      return;
    }
    let chats;
    try {
      chats = (await api(ROLE, "/api/phone/chats")).chats;
    } catch (e) {
      return toast(e.message, true);
    }
    if (!chats.length) return toast("Нет подключённых компьютеров — подключи по QR-коду", true);
    const target = chats.length === 1 ? chats[0] : await chooseChat(chats);
    if (!target) return;
    try {
      await api(ROLE, "/api/tools/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: results.map((r) => r.id), chat_id: target.id }),
      });
      toast(`Отправлено на «${target.label}»`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- кнопки
  $("toolCamera").addEventListener("click", () => $("toolCameraInput").click());
  $("toolPick").addEventListener("click", () => $("toolPickInput").click());
  for (const id of ["toolCameraInput", "toolPickInput"]) {
    $(id).addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  }
  $("toolRun").addEventListener("click", run);

  // Компьютер: файлы можно перетащить мышкой в окно инструмента или вставить Ctrl+V.
  const view = $("toolView");
  const drop = $("toolDrop");
  if (drop) {
    let depth = 0;
    view.parentElement.addEventListener("dragenter", (e) => {
      if (view.hidden || !tool || ![...e.dataTransfer.types].includes("Files")) return;
      depth++;
      drop.hidden = false;
    });
    view.parentElement.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
    view.parentElement.addEventListener("dragover", (e) => { if (!view.hidden) e.preventDefault(); });
    view.parentElement.addEventListener("drop", (e) => {
      if (view.hidden) return;
      e.preventDefault();
      depth = 0;
      drop.hidden = true;
      addFiles(e.dataTransfer.files);
    });
  }
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || view.hidden || view.offsetParent === null || !tool) return;
    e.preventDefault();
    addFiles(files);
  });
  $("toolShareAll").addEventListener("click", () => shareFiles(results));
  $("toolSendPc").addEventListener("click", sendToPc);

  return { renderHome, open, has: (id) => TOOLS.some((t) => t.id === id) };
})();
