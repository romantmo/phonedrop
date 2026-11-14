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

  const PDF_ACCEPT = "application/pdf,.pdf";

  const TOOLS = [
    {
      id: "scan", op: "scan", icon: "📷", title: tx("Сканер документов"),
      sub: tx("Фото страниц → ровный PDF"),
      hint: tx("Сфотографируй страницы — лист найдётся сам. Нажми на страницу, чтобы поправить."),
      camera: true, scanner: true, accept: IMAGE_ACCEPT, multi: true, arrange: true, rotate: true, min: 1,
      action: tx("Сделать PDF"),
    },
    {
      id: "sign", op: "pdf-sign", icon: "✍️", title: tx("Подписать PDF"),
      sub: tx("Подпись пальцем или мышкой"),
      hint: tx("Выбери PDF, нажми на страницу и поставь подпись туда, где нужно."),
      accept: PDF_ACCEPT, multi: false, min: 1, pages: "sign", action: tx("Подписать"),
    },
    {
      id: "office", op: "office-pdf", icon: "📄", title: tx("Документ → PDF"),
      sub: "Word, Excel, PowerPoint",
      hint: tx("Выбери файл Word, Excel или PowerPoint — получишь PDF, который откроется на любом устройстве."),
      accept: OFFICE_ACCEPT, multi: false, min: 1, action: tx("Превратить в PDF"),
    },
    {
      id: "compresspdf", op: "compress-pdf", icon: "🪶", title: tx("Сжать PDF"),
      sub: tx("Тяжёлый PDF → лёгкий"),
      hint: tx("Например, скан из почты на 20 МБ. Картинки внутри пережимаются, текст остаётся текстом — его можно выделять и искать."),
      accept: PDF_ACCEPT, multi: false, min: 1, action: tx("Сжать PDF"),
      opts: [{ key: "preset", def: "normal", choices: [["light", tx("Маленький")], ["normal", tx("Средний")], ["max", tx("Высокое качество")]] }],
    },
    {
      id: "merge", op: "merge-pdf", icon: "📎", title: tx("Объединить PDF"),
      sub: tx("Несколько PDF → один"),
      hint: tx("Выбери два или больше PDF и расставь в нужном порядке."),
      accept: PDF_ACCEPT, multi: true, arrange: true, min: 2, action: tx("Объединить"),
    },
    {
      id: "pages", op: "pdf-pages", icon: "📑", title: tx("Страницы PDF"),
      sub: tx("Разделить, удалить, повернуть"),
      hint: tx("Убери лишние страницы, поверни или поменяй местами. Можно сохранить каждую страницу отдельным PDF."),
      accept: PDF_ACCEPT, multi: false, min: 1, pages: "edit", action: tx("Готово"),
      opts: [{ key: "split", def: "one", choices: [["one", tx("Один PDF")], ["split", tx("Каждая страница — отдельно")]] }],
    },
    {
      id: "pdfimg", op: "pdf-images", icon: "🖼", title: tx("PDF → картинки"),
      sub: tx("Каждая страница — отдельный JPG"),
      hint: tx("Удобно, чтобы отправить страницу документа как фото."),
      accept: PDF_ACCEPT, multi: false, min: 1, action: tx("Сделать картинки"),
    },
    {
      id: "lock", op: "pdf-protect", icon: "🔒", title: tx("Пароль на PDF"),
      sub: tx("Поставить или снять"),
      hint: tx("С паролем PDF откроет только тот, кто его знает. Снять пароль можно, если ты его помнишь."),
      accept: PDF_ACCEPT, multi: false, min: 1,
      opts: [{ key: "mode", def: "set", choices: [["set", tx("Поставить пароль")], ["remove", tx("Снять пароль")]] }],
      field: { key: "password", type: "password", placeholder: tx("Пароль") },
      opFor: (v) => (v.mode === "remove" ? "pdf-unprotect" : "pdf-protect"),
      actionFor: (v) => (v.mode === "remove" ? tx("Снять пароль") : tx("Поставить пароль")),
    },
    {
      id: "compress", op: "images-jpg", icon: "🗜", title: tx("Сжать фото / HEIC → JPG"),
      sub: tx("Меньше размер, без геолокации"),
      hint: tx("Фото станут легче для почты и мессенджеров. Из них удаляются геолокация и данные телефона."),
      accept: IMAGE_ACCEPT, multi: true, min: 1,
      opts: [{ key: "preset", def: "email", choices: [["email", tx("Для почты")], ["small", tx("Сильнее")], ["original", tx("Только в JPG")]] }],
      action: tx("Сжать"),
    },
    {
      id: "photo", op: "images-convert", icon: "📐", title: tx("Размер и формат фото"),
      sub: tx("Уменьшить, JPG / PNG / WebP"),
      hint: tx("Уменьши фото до нужного размера или сохрани в другом формате. Данные о месте съёмки удаляются."),
      accept: IMAGE_ACCEPT, multi: true, min: 1, action: tx("Готово"),
      opts: [
        { key: "size", def: "2048", label: tx("Размер"),
          choices: [["orig", tx("Как есть")], ["2048", "2048 px"], ["1280", "1280 px"], ["800", "800 px"]] },
        { key: "format", def: "jpg", label: tx("Формат"), choices: [["jpg", "JPG"], ["png", "PNG"], ["webp", "WebP"]] },
      ],
    },
  ];

  let tool = null;
  let items = [];      // [{ file, rot, preview }]
  let results = [];
  let optVals = {};    // выбранные настройки: { preset: "normal", ... }
  let fieldVal = "";   // поле ввода (пароль)
  let pages = [];      // «Страницы PDF» / «Подписать»: [{ i, rot, url }]
  let pagesLoading = false;
  let sign = null;     // { page, x, y, w } — где стоит подпись
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
        tx("🔒 Файлы обрабатываются на твоём сервере PhoneDrop, не на чужих сайтах. Результат хранится 30 минут и удаляется.")));
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
    pages = [];
    sign = null;
    fieldVal = "";
    optVals = Object.fromEntries((tool.opts || []).map((o) => [o.key, o.def]));
    $("toolResults").hidden = true;
    $("toolIcon").textContent = tool.icon;
    $("toolTitle").textContent = tool.title;
    $("toolSub").textContent = tool.sub;
    $("toolHint").textContent = tool.hint + (ON_PC ? tx(" Файлы можно перетащить мышкой в это окно или вставить Ctrl+V.") : "");
    for (const id of ["toolFiles", "toolAdd", "toolFoot"]) $(id).hidden = false;
    $("toolCamera").hidden = !tool.camera || ON_PC;
    $("toolPick").textContent = tool.camera && !ON_PC ? tx("🖼 Галерея") : tool.multi ? tx("📂 Выбрать файлы") : tx("📂 Выбрать файл");
    $("toolSendPc").textContent = ON_PC ? tx("📱 На телефон") : tx("💻 На компьютер");
    $("toolSendPc").hidden = document.body.dataset.guest === "1";  // у собеседника по коду нет своих компьютеров
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
      if (first < 0) return toast(tx("Сначала добавь страницу"), true);
      editPage(first, "look");
    });
  }

  const opFor = () => (tool.opFor ? tool.opFor(optVals) : tool.op);
  const actionFor = () => (tool.actionFor ? tool.actionFor(optVals) : tool.action);

  // Настройки инструмента: одна или несколько строк-переключателей и поле (пароль).
  function renderOptions() {
    const box = $("toolOptions");
    const groups = tool.opts || [];
    box.hidden = !groups.length && !tool.field;
    const rows = groups.map((g) => el("div", { class: "opt-row" },
      g.label ? el("div", { class: "opt-label" }, g.label) : null,
      el("div", { class: "seg" }, ...g.choices.map(([value, label]) =>
        el("button", { type: "button", class: value === optVals[g.key] ? "on" : "",
          onclick: () => { optVals[g.key] = value; renderOptions(); staleResults(); render(); } }, label)))));
    if (tool.field) {
      const input = el("input", { class: "opt-input", type: tool.field.type, placeholder: tool.field.placeholder,
        autocomplete: "off", maxlength: "128", dir: "auto" });
      input.value = fieldVal;
      input.addEventListener("input", () => { fieldVal = input.value; staleResults(); render(); });
      rows.push(input);
    }
    box.replaceChildren(...rows);
  }

  function addFiles(list) {
    let files = [...list];
    if (!files.length) return;
    // Перетащили или вставили не тот тип файла — отсеиваем сразу, без похода на сервер.
    const ok = (f) => tool.accept.split(",").some((a) => a.startsWith(".")
      ? f.name.toLowerCase().endsWith(a) : a.endsWith("/*") ? f.type.startsWith(a.slice(0, -1)) : f.type === a);
    if (files.some((f) => !ok(f))) {
      toast(tool.accept === IMAGE_ACCEPT ? tx("Здесь можно использовать только фото") : tx("Этот тип файла здесь не подходит"), true);
      files = files.filter(ok);
      if (!files.length) return;
    }
    if (tool.scanner) return uploadScan(files);
    if (tool.pages) {
      items = [{ file: files[0], rot: 0, preview: null }];
      staleResults();
      return loadPages();
    }
    if (!tool.multi) {
      items.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      items = [];
      files = files.slice(0, 1);
    }
    for (const file of files) {
      if (items.length >= MAX_FILES) { toast(tx("Не больше {0} файлов за раз", MAX_FILES), true); break; }
      items.push({ file, rot: 0, preview: isImage(file) ? URL.createObjectURL(file) : null });
    }
    staleResults();
    render();
  }

  // «Страницы PDF» и «Подписать»: сервер рисует маленькие картинки страниц.
  async function loadPages() {
    pages = [];
    sign = null;
    pagesLoading = true;
    render();
    const fd = new FormData();
    fd.append("files", items[0].file, items[0].file.name);
    try {
      const data = await api(ROLE, "/api/tools/pdf-thumbs", { method: "POST", body: fd });
      pages = data.results.map((r, i) => ({ i, rot: 0, url: r.url }));
    } catch (e) {
      items = [];
      toast(e.message, true);
    } finally {
      pagesLoading = false;
      render();
    }
  }

  function movePage(k, delta) {
    const j = k + delta;
    if (j < 0 || j >= pages.length) return;
    [pages[k], pages[j]] = [pages[j], pages[k]];
    staleResults();
    render();
  }

  // Плитка страницы: для «Страниц PDF» — повернуть, переставить, убрать; для «Подписать» — нажать и подписать.
  function pdfPageCard(pg, k) {
    const signed = sign && sign.page === pg.i;
    const img = el("img", { src: pg.url, alt: "", loading: "lazy", class: "rot-" + pg.rot });
    const thumbBox = el("div", { class: "pg-img" }, img);
    if (signed && PDSign.image()) {
      thumbBox.append(el("img", { class: "pg-sig", src: PDSign.image(), alt: "",
        style: `left:${sign.x * 100}%;top:${sign.y * 100}%;width:${sign.w * 100}%` }));
    }
    if (tool.pages === "sign") {
      return el("div", { class: "page-card" + (signed ? " signed" : "") },
        el("button", { type: "button", class: "page-thumb", "aria-label": tx("Подписать страницу {0}", k + 1),
          onclick: () => signPage(pg) },
          thumbBox,
          el("span", { class: "page-num" }, String(k + 1)),
          el("span", { class: "page-status" }, signed ? tx("✍️ Изменить") : tx("✍️ Подписать здесь"))));
    }
    return el("div", { class: "page-card" },
      el("div", { class: "page-thumb" }, thumbBox, el("span", { class: "page-num" }, String(pg.i + 1))),
      el("div", { class: "page-ctrl" },
        el("button", { type: "button", "aria-label": tx("Повернуть"),
          onclick: () => { pg.rot = (pg.rot + 90) % 360; staleResults(); render(); } }, "⟳"),
        el("button", { type: "button", class: "flip-rtl", "aria-label": tx("Раньше"), disabled: k === 0, onclick: () => movePage(k, -1) }, "←"),
        el("button", { type: "button", class: "flip-rtl", "aria-label": tx("Позже"), disabled: k === pages.length - 1, onclick: () => movePage(k, 1) }, "→"),
        el("button", { type: "button", class: "del", "aria-label": tx("Убрать"),
          onclick: () => { pages.splice(k, 1); staleResults(); render(); } }, "✕")));
  }

  async function signPage(pg) {
    const placed = await PDSign.place(pg.url, sign && sign.page === pg.i ? sign : null);
    if (!placed) return;
    sign = { page: pg.i, ...placed };
    staleResults();
    render();
  }

  // Сканер: каждое фото сразу загружается на сервер (пачками до 20).
  async function uploadScan(files) {
    files = files.slice(0, Math.max(0, MAX_FILES - items.length));
    for (let start = 0; start < files.length; start += 20) {
      const batch = files.slice(start, start + 20);
      const holders = batch.map((f) => ({ uploading: true, name: f.name || tx("фото"), progress: 0 }));
      items.push(...holders);
      uploading += batch.length;
      staleResults();
      render();
      try {
        const pages = await PDScanner.upload(batch, (p) => {
          holders.forEach((h) => (h.progress = p));
          document.querySelectorAll(".page-card.loading .page-status").forEach((n) => (n.textContent =
            p < 1 ? tx("Загрузка {0}%", Math.round(p * 100)) : tx("Ищу лист на фото…")));
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
      el("button", { type: "button", class: "page-thumb", disabled: busyItem, "aria-label": tx("Обрезать страницу {0}", i + 1),
        onclick: () => editPage(i) },
        busyItem ? el("span", { class: "tf-spinner" })
          : el("img", { src: PDScanner.previewUrl(item, 360), alt: "", loading: "lazy" }),
        el("span", { class: "page-num" }, String(i + 1)),
        busyItem ? el("span", { class: "page-status" }, tx("Загрузка…"))
          : el("span", { class: "page-status" }, tx("✂️ Обрезать"))),
      el("div", { class: "page-ctrl" },
        el("button", { type: "button", "aria-label": tx("Повернуть"), disabled: busyItem,
          onclick: () => { item.rot = (item.rot + 90) % 360; staleResults(); render(); } }, "⟳"),
        el("button", { type: "button", class: "flip-rtl", "aria-label": tx("Раньше"), disabled: i === 0, onclick: () => move(i, -1) }, "←"),
        el("button", { type: "button", class: "flip-rtl", "aria-label": tx("Позже"), disabled: i === items.length - 1, onclick: () => move(i, 1) }, "→"),
        el("button", { type: "button", class: "del", "aria-label": tx("Убрать"), onclick: () => removeItem(i) }, "✕")));
  }

  function renderPdfPages() {
    const list = $("toolFiles");
    list.classList.remove("pages");
    list.classList.toggle("still", pages.length > 0);  // без анимации появления при каждом нажатии
    const file = items[0];
    const head = file ? el("div", { class: "tf-item" },
      el("div", { class: "tf-thumb" }, el("span", { class: "tf-ext" }, "pdf")),
      el("div", { class: "tf-info" },
        el("div", { class: "tf-name" }, file.file.name),
        el("div", { class: "tf-size" }, pagesLoading ? tx("Загружаю страницы…") : tx("Страниц: {0}", pages.length))),
      el("div", { class: "tf-ctrl" }, el("button", { type: "button", class: "del", "aria-label": tx("Убрать"),
        onclick: () => { items = []; pages = []; sign = null; staleResults(); render(); } }, "✕"))) : null;
    const grid = el("div", { class: "tool-files pages" }, ...pages.map((pg, k) => pdfPageCard(pg, k)));
    list.replaceChildren(...[head, pages.length ? grid : null].filter(Boolean));
    if (!file) list.append(el("div", { class: "tf-empty" }, tx("Файл ещё не выбран")));
    if (pagesLoading) list.append(el("div", { class: "tf-empty" }, el("span", { class: "tf-spinner" })));
    if (tool.pages === "sign" && pages.length && !sign) {
      list.append(el("div", { class: "tf-empty" }, tx("Нажми на страницу, где нужна подпись")));
    }
    const run = $("toolRun");
    const ready = tool.pages === "sign" ? !!sign : pages.length > 0;
    run.disabled = busy || pagesLoading || !ready;
    run.textContent = busy ? tx("Обрабатываю…") : actionFor();
  }

  function render() {
    if (tool.pages) return renderPdfPages();
    const list = $("toolFiles");
    list.classList.remove("still");
    list.classList.toggle("pages", !!tool.scanner && items.length > 0);
    list.replaceChildren(...items.map((item, i) => tool.scanner ? pageCard(item, i) :
      el("div", { class: "tf-item" },
        tool.arrange ? el("span", { class: "tf-num" }, String(i + 1)) : null,
        thumb(item, i),
        el("div", { class: "tf-info" },
          el("div", { class: "tf-name" }, item.file.name),
          el("div", { class: "tf-size" }, fmtSize(item.file.size))),
        el("div", { class: "tf-ctrl" },
          tool.rotate ? el("button", { type: "button", "aria-label": tx("Повернуть"), title: tx("Повернуть"),
            onclick: () => { item.rot = (item.rot + 90) % 360; staleResults(); render(); } }, "⟳") : null,
          tool.arrange && i > 0 ? el("button", { type: "button", "aria-label": tx("Выше"), onclick: () => move(i, -1) }, "↑") : null,
          tool.arrange && i < items.length - 1 ? el("button", { type: "button", "aria-label": tx("Ниже"), onclick: () => move(i, 1) }, "↓") : null,
          el("button", { type: "button", class: "del", "aria-label": tx("Убрать"), onclick: () => removeItem(i) }, "✕")))));
    if (!items.length) {
      list.append(el("div", { class: "tf-empty" }, tool.camera ? tx("Пока нет страниц") : tx("Файл ещё не выбран")));
    }
    if (tool.camera) $("toolCamera").textContent = tx("📷 Камера");
    const run = $("toolRun");
    run.disabled = busy || uploading > 0 || items.length < tool.min || (tool.field && !fieldVal);
    run.textContent = busy ? tx("Обрабатываю…") : items.length && items.length < tool.min
      ? tx("Нужно ещё {0}", tool.min - items.length) : actionFor();
  }

  // ---------- запуск
  function scanName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return tx("Скан {0}-{1}-{2} {3}-{4}", d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
  }

  async function runScan() {
    busy = true;
    staleResults();
    render();
    const bar = $("toolProgress");
    bar.hidden = false;
    bar.classList.add("working");
    $("toolRun").textContent = tx("Собираю PDF…");
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

  async function run() {
    if (busy || uploading || items.length < tool.min) return;
    if (tool.scanner) return runScan();
    const fd = new FormData();
    for (const item of items) fd.append("files", item.file, item.file.name);
    for (const [key, value] of Object.entries(optVals)) fd.append(key, value);
    if (tool.field) fd.append(tool.field.key, fieldVal);
    if (tool.pages === "edit") fd.append("pages", JSON.stringify(pages.map((pg) => ({ i: pg.i, rot: pg.rot }))));
    if (tool.pages === "sign") {
      if (!sign) return;
      fd.append("files", await PDSign.blob(), "signature.png");
      fd.append("sign", JSON.stringify(sign));
    }
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
    xhr.open("POST", `/api/tools/${opFor()}`);
    xhr.setRequestHeader("X-PD-Role", ROLE);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      fill.style.width = Math.round((e.loaded / e.total) * 100) + "%";
      if (e.loaded === e.total) { bar.classList.add("working"); $("toolRun").textContent = tx("Конвертирую…"); }
    };
    const done = () => { busy = false; bar.hidden = true; render(); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      done();
      if (xhr.status !== 200) {
        toast((data && data.detail) || tx("Ошибка {0}", xhr.status), true);
        return;
      }
      results = data.results;
      showResults(data.ttl_min);
    };
    xhr.onerror = () => { done(); toast(tx("Нет связи с сервером"), true); };
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
          r.viewable ? el("a", { href: r.url, target: "_blank", rel: "noopener" }, tx("Открыть")) : null,
          el("a", { href: r.download_url, download: r.name }, tx("Скачать"))))));
    $("toolShareAll").hidden = !canShareFiles;
    $("toolShareAll").textContent = results.length > 1 ? tx("📤 Поделиться ({0})", results.length) : tx("📤 Поделиться");
    let note = tx("Файлы хранятся на сервере {0} минут, потом удаляются.", ttl);
    if (tool.op === "compress-pdf" && items[0] && results[0]) {
      const before = items[0].file.size;
      const after = results[0].size;
      note = (after < before
        ? tx("Было {0} → стало {1} (−{2}%). ", fmtSize(before), fmtSize(after), Math.round((1 - after / before) * 100))
        : tx("Меньше не получилось — этот PDF уже сжат. ")) + note;
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
          el("h3", {}, tx("На какой компьютер?")),
          ...chats.map((c) => el("button", { type: "button", onclick: () => close(c) },
            el("span", {}, c.label), c.pc_online ? el("span", { class: "sheet-online" }, tx("в сети")) : null)),
          el("button", { type: "button", class: "cancel", onclick: () => close(null) }, tx("Отмена"))));
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
        toast(tx("Отправлено на телефон"));
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
    if (!chats.length) return toast(tx("Нет подключённых компьютеров — подключи по QR-коду"), true);
    const target = chats.length === 1 ? chats[0] : await chooseChat(chats);
    if (!target) return;
    try {
      await api(ROLE, "/api/tools/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: results.map((r) => r.id), chat_id: target.id }),
      });
      toast(tx("Отправлено на «{0}»", target.label));
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
