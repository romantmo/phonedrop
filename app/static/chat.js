// PhoneDrop — общая логика чата для компьютера и телефона.
// Правило безопасности: текст от пользователя вставляется только через textContent,
// никогда через innerHTML — так чужой «скрипт в сообщении» не сможет выполниться.
"use strict";

window.PD = (() => {
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  function toast(message, isError = false) {
    let t = $("toast");
    if (!t) {
      t = el("div", { id: "toast", class: "toast", role: "status" });
      document.body.append(t);
    }
    t.textContent = message;
    t.className = "toast show" + (isError ? " err" : "");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = "toast"), 2600);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + tx(" Б");
    if (bytes < 1024 ** 2) return Math.round(bytes / 1024) + tx(" КБ");
    if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + tx(" МБ");
    return (bytes / 1024 ** 3).toFixed(2) + tx(" ГБ");
  }

  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString(PDI18N.locale, { hour: "2-digit", minute: "2-digit" });

  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function dayLabel(ts) {
    const d = new Date(ts * 1000);
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return tx("Сегодня");
    if (d.toDateString() === yesterday.toDateString()) return tx("Вчера");
    return d.toLocaleDateString(PDI18N.locale, { day: "numeric", month: "long" });
  }

  async function api(role, path, options = {}) {
    const headers = Object.assign({ "X-PD-Role": role }, options.headers || {});
    const response = await fetch(path, Object.assign({}, options, { headers, credentials: "same-origin" }));
    let data = null;
    try { data = await response.json(); } catch { /* пустой ответ */ }
    if (!response.ok) {
      const error = new Error((data && data.detail) || tx("Ошибка {0}", response.status));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el("textarea", { class: "offscreen" });
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(tx("Скопировано"));
  }

  async function copyImage(url) {
    try {
      const blob = await (await fetch(url, { credentials: "same-origin" })).blob();
      let png = blob;
      if (blob.type !== "image/png") {
        // Буфер обмена браузера принимает только PNG — конвертируем.
        const bitmap = await createImageBitmap(blob);
        const canvas = el("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast(tx("Картинка скопирована — вставляй через Ctrl+V"));
    } catch {
      toast(tx("Браузер не дал скопировать картинку. Скачай её"), true);
    }
  }

  // Ссылки делаем кликабельными, но только http/https — никаких javascript:.
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  function linkify(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      let url = match[0].replace(/[.,!?;:)\]]+$/, "");
      frag.append(text.slice(last, match.index));
      frag.append(el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
      last = match.index + url.length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  const IMG_RE = /^image\/(png|jpeg|gif|webp|avif)$/;

  // ---------- «Поделиться» (WhatsApp, Telegram, почта…) через системное меню телефона.
  // Браузер разрешает открыть это меню только сразу после нажатия, поэтому файл
  // лучше скачать заранее (prefetchShare), а при нажатии — сразу показать меню.
  const shareCache = new Map();
  const canShareFiles = (() => {
    try {
      return !!(navigator.share && navigator.canShare &&
        navigator.canShare({ files: [new File(["x"], "x.pdf", { type: "application/pdf" })] }));
    } catch { return false; }
  })();

  async function fetchFile(item) {
    if (shareCache.has(item.url)) return shareCache.get(item.url);
    const response = await fetch(item.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(tx("Файл больше недоступен"));
    const blob = await response.blob();
    const file = new File([blob], item.name, { type: item.mime || blob.type });
    shareCache.set(item.url, file);
    return file;
  }

  function prefetchShare(items) {
    if (canShareFiles) items.forEach((i) => fetchFile(i).catch(() => {}));
  }

  async function share(files) {
    if (!navigator.canShare({ files })) {
      toast(tx("Этот тип файла нельзя отправить через «Поделиться» — скачай его"), true);
      return;
    }
    try {
      await navigator.share({ files });
    } catch (e) {
      if (e.name !== "AbortError") toast(tx("Нажми «Поделиться» ещё раз"), true);
    }
  }

  async function shareFiles(items) {
    const ready = items.map((i) => shareCache.get(i.url));
    if (ready.every(Boolean)) return share(ready);
    const started = Date.now();
    toast(tx("Готовлю файл…"));
    let files;
    try {
      files = await Promise.all(items.map(fetchFile));
    } catch (e) {
      return toast(e.message, true);
    }
    // Если скачивание заняло долго, браузер уже «забыл» нажатие — просим нажать ещё раз.
    if (Date.now() - started < 3000) return share(files);
    toast(tx("Файл готов — нажми «Поделиться» ещё раз"));
  }

  // Сколько осталось жить файлу: «⏳ 23 ч» (файлы в чате с человеком хранятся сутки).
  function fmtLeft(expires) {
    const min = (expires * 1000 - Date.now()) / 60000;
    if (min <= 0) return tx("удаляется");
    return min >= 60 ? tx("удалится через {0} ч", Math.floor(min / 60)) : tx("удалится через {0} мин", Math.max(1, Math.round(min)));
  }

  // Чат. Подходит и для «телефон ↔ компьютер», и для «чата с человеком» (room.js):
  // там переопределены отправка (sendText, sendFiles, sendVoice), удаление и адрес WebSocket.
  class Chat {
    constructor(opts) {
      this.opts = opts;
      this.role = opts.role;           // заголовок X-PD-Role для запросов
      this.me = opts.me || opts.role;  // какие сообщения «мои» (справа)
      this.mobile = opts.mobile ?? opts.role === "phone";
      this.chatId = opts.chatId || null; // какой чат сейчас открыт
      this.maxUploadMb = 500;
      this.list = $("messages");
      this.input = $("msgInput");
      this.actionBtn = $("actionBtn");
      this.unread = 0;
      this.delay = 1000;
      this.stopped = false;
      this.bindComposer();
      this.bindDropAndPaste();
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) { this.unread = 0; document.title = "PhoneDrop"; }
      });
    }

    // ------------------------------------------------ лента
    setMessages(messages) {
      this.list.querySelectorAll(".msg, .day").forEach((n) => n.remove());
      this.lastDay = null;
      for (const m of messages) this.add(m, false);
      this.updateEmpty();
      this.scrollDown(true);
    }

    add(m, animate = true) {
      if ($("m-" + m.id)) return;
      const day = dayLabel(m.created);
      // Пока что-то отправляется, новые сообщения встают над «полосками отправки».
      const anchor = this.list.querySelector(".msg.pending");
      const place = (n) => (anchor ? this.list.insertBefore(n, anchor) : this.list.append(n));
      if (day !== this.lastDay) {
        place(el("div", { class: "day" }, day));
        this.lastDay = day;
      }
      const node = this.render(m);
      if (!animate) node.style.animation = "none";
      place(node);
      this.updateEmpty();
      this.scrollDown(m.sender === this.me);
    }

    remove(id) {
      $("m-" + id)?.remove();
      this.updateEmpty();
    }

    updateEmpty() {
      const empty = $("empty");
      if (empty) empty.hidden = !!this.list.querySelector(".msg");
    }

    scrollDown(force) {
      const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 200;
      if (force || nearBottom) requestAnimationFrame(() => (this.list.scrollTop = this.list.scrollHeight));
    }

    render(m) {
      const mine = m.sender === this.me;
      const bubble = el("div", { class: "bubble kind-" + m.kind });
      const actions = el("div", { class: "actions" });

      if (m.kind === "text") {
        bubble.append(el("div", { class: "text", dir: "auto" }, linkify(m.text)));
        actions.append(el("button", { type: "button", onclick: () => copyText(m.text) }, tx("Копировать")));
      } else if (m.expired) {
        bubble.append(el("div", { class: "expired-file" },
          (m.kind === "voice" ? tx("🎤 Голосовое") : "📎 " + m.name) + tx(" — удалено, срок хранения истёк")));
      } else if (m.kind === "voice") {
        bubble.append(
          el("div", { class: "voice-label" }, tx("🎤 Голосовое") + (m.duration ? " · " + fmtDuration(m.duration) : "")),
          el("audio", { controls: true, preload: "metadata", src: m.url })
        );
        actions.append(el("a", { href: m.download_url, download: m.name }, tx("Скачать")));
      } else {
        const mime = m.mime || "";
        if (IMG_RE.test(mime)) {
          bubble.append(el("a", { class: "media", href: m.url, target: "_blank", rel: "noopener" },
            el("img", { class: "media-img", src: m.url, alt: m.name, loading: "lazy" })));
        } else if (mime.startsWith("video/")) {
          bubble.append(el("div", { class: "media" },
            el("video", { src: m.url, controls: true, preload: "metadata", playsinline: true })));
        } else if (mime.startsWith("audio/")) {
          bubble.append(el("audio", { controls: true, preload: "metadata", src: m.url }));
        }
        if (IMG_RE.test(mime) || mime.startsWith("video/")) {
          bubble.append(el("div", { class: "caption" }, `${m.name} · ${fmtSize(m.size)}`));
        } else {
          // Нажатие на файл: PDF, текст и т.п. открываются в новой вкладке,
          // остальное (docx, zip, exe...) — скачивается, а телефон предложит, чем открыть.
          const ext = (m.name.includes(".") ? m.name.split(".").pop() : "file").slice(0, 4);
          const openUrl = m.viewable ? m.url : m.preview_url;  // Word/Excel/PowerPoint — просмотр как PDF
          const open = openUrl
            ? { href: openUrl, target: "_blank", rel: "noopener", title: tx("Открыть") }
            : { href: m.download_url, download: m.name, title: tx("Скачать") };
          bubble.append(el("a", { class: "file-row", ...open },
            el("div", { class: "ext" }, ext),
            el("div", { class: "finfo" },
              el("div", { class: "fname", dir: "auto" }, m.name),
              el("div", { class: "fsize" }, fmtSize(m.size) + (openUrl ? tx(" · нажми, чтобы открыть") : "")))));
        }
        if (m.viewable && !mime.startsWith("video/") && !mime.startsWith("audio/")) {
          actions.append(el("a", { href: m.url, target: "_blank", rel: "noopener" }, tx("Открыть")));
        } else if (m.preview_url) {
          actions.append(el("a", { href: m.preview_url, target: "_blank", rel: "noopener" }, tx("Открыть")));
        }
        actions.append(el("a", { href: m.download_url, download: m.name }, tx("Скачать")));
        if (m.convert_to) {
          const btn = el("button", { type: "button", onclick: () => this.convertMessage(m.id, btn) },
            m.convert_to === "pdf" ? tx("В PDF") : tx("В JPG"));
          actions.append(btn);
        }
        if (this.mobile && canShareFiles) {
          actions.append(el("button", { type: "button",
            onclick: () => shareFiles([{ url: m.url, name: m.name, mime: m.mime }]) }, tx("Поделиться")));
        }
        if (IMG_RE.test(mime) && window.ClipboardItem && !this.mobile) {
          actions.append(el("button", { type: "button", onclick: () => copyImage(m.url) }, tx("Копировать картинку")));
        }
      }

      if (this.canDelete(m)) {
        actions.append(el("button", { type: "button", class: "del", onclick: () => this.deleteMessage(m.id) }, tx("Удалить")));
      }
      bubble.append(actions);
      bubble.append(el("div", { class: "meta" },
        m.expires && !m.expired ? el("span", { class: "ttl", title: tx("Файлы в этом чате хранятся сутки") }, "⏳ " + fmtLeft(m.expires)) : null,
        fmtTime(m.created), mine ? el("span", { class: "tick" }, "✓✓") : null));
      return el("div", { class: "msg " + (mine ? "out" : "in"), id: "m-" + m.id }, bubble);
    }

    async convertMessage(id, btn) {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = tx("Конвертирую…");
      try {
        await api(this.role, `/api/messages/${id}/convert`, { method: "POST" });
        toast(tx("Готово — новый файл в чате"));
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }

    canDelete() { return true; }
    deleteUrl(id) { return "/api/messages/" + id; }

    async deleteMessage(id) {
      try {
        await api(this.role, this.deleteUrl(id), { method: "DELETE" });
        this.remove(id);
      } catch (e) {
        toast(e.message, true);
      }
    }

    // ------------------------------------------------ отправка
    bindComposer() {
      const input = this.input;
      const resize = () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
        this.actionBtn.classList.toggle("has-text", input.value.trim().length > 0);
        this.actionBtn.setAttribute("aria-label", input.value.trim() ? tx("Отправить") : tx("Записать голосовое"));
      };
      input.addEventListener("input", resize);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && (this.opts.enterSends || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.sendText();
        }
      });
      this.actionBtn.addEventListener("click", () => {
        if (input.value.trim()) this.sendText();
        else this.startRecording();
      });
      $("attachBtn").addEventListener("click", () => this.openAttach());
      $("recCancel").addEventListener("click", () => this.stopRecording(false));
      $("recSend").addEventListener("click", () => this.stopRecording(true));
      this._resize = resize;
    }

    bindDropAndPaste() {
      const zone = $("dropZone");
      const overlay = $("dropOverlay");
      if (zone && overlay) {
        let depth = 0;
        zone.addEventListener("dragenter", (e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          depth++;
          overlay.hidden = false;
        });
        zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
        zone.addEventListener("dragover", (e) => e.preventDefault());
        zone.addEventListener("drop", (e) => {
          e.preventDefault();
          depth = 0;
          overlay.hidden = true;
          if (e.dataTransfer.files.length) this.sendFiles([...e.dataTransfer.files]);
        });
      }
      // Ctrl+V скриншота или файла — сразу отправка.
      document.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (!files.length || (zone && zone.hidden)) return;  // открыт не чат (например, «Инструменты»)
        e.preventDefault();
        this.sendFiles(files);
      });
    }

    // ------------------------------------------------ меню «Прикрепить»
    // На телефоне — плитки (галерея, камера, файлы, место…). На компьютере — сразу выбор файла.
    openAttach() {
      if (!matchMedia("(pointer: coarse)").matches) return this.pickFiles({ multiple: true });
      const close = () => {
        back.classList.remove("show");
        document.removeEventListener("keydown", onKey);
        setTimeout(() => back.remove(), 200);
      };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      const tile = (ico, label, sub, color, fn) =>
        el("button", { type: "button", class: "at-tile " + color, onclick: () => { close(); fn(); } },
          el("span", { class: "at-ico", "aria-hidden": "true" }, ico), el("b", {}, label), el("small", {}, sub));
      const tiles = [
        tile("🖼", tx("Галерея"), tx("фото и видео"), "c1", () => this.pickFiles({ accept: "image/*,video/*", multiple: true })),
        tile("📷", tx("Камера"), tx("сделать фото"), "c2", () => this.pickFiles({ accept: "image/*", capture: "environment" })),
        tile("🎥", tx("Видео"), tx("снять видео"), "c3", () => this.pickFiles({ accept: "video/*", capture: "environment" })),
        tile("📁", tx("Файлы"), tx("Диск, Загрузки"), "c4", () => this.pickFiles({ multiple: true })),
        tile("📍", tx("Место"), tx("где я сейчас"), "c5", () => this.sendLocation()),
      ];
      // Контакты из телефонной книги умеет отдавать только Chrome на Android.
      if ("contacts" in navigator && "ContactsManager" in window) {
        tiles.push(tile("👤", tx("Контакт"), tx("из телефона"), "c6", () => this.sendContact()));
      }
      if (navigator.clipboard && navigator.clipboard.read) {
        tiles.push(tile("📋", tx("Вставить"), tx("что скопировал"), "c7", () => this.pasteClipboard()));
      }
      const back = el("div", { class: "at-back", onclick: (e) => { if (e.target === back) close(); } },
        el("div", { class: "at-sheet", role: "dialog", "aria-label": tx("Прикрепить") },
          el("div", { class: "at-grip" }),
          el("div", { class: "at-grid" }, ...tiles)));
      document.body.append(back);
      document.addEventListener("keydown", onKey);
      requestAnimationFrame(() => back.classList.add("show"));
    }

    // Системное окно выбора файла. capture="environment" сразу открывает заднюю камеру.
    // (Не «pick»: так называется выбор того же файла для продолжения отправки в чатах с людьми.)
    pickFiles({ accept = null, capture = null, multiple = false }) {
      const input = el("input", { type: "file", accept, capture, multiple, hidden: true });
      const done = () => setTimeout(() => input.remove(), 0);
      input.addEventListener("change", () => {
        const files = [...input.files];
        done();
        if (files.length) this.sendFiles(files);
      });
      input.addEventListener("cancel", done);
      document.body.append(input);
      input.click();
    }

    // Отправляет готовый текст (место, контакт), не трогая то, что человек уже набирал.
    async sendTextValue(text) {
      const draft = this.input.value;
      this.input.value = text;
      await this.sendText();
      this.input.value = draft;
      this._resize();
    }

    sendLocation() {
      if (!navigator.geolocation) return toast(tx("Это устройство не умеет определять место"), true);
      toast(tx("Определяю, где ты…"));
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          const url = `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
          this.sendTextValue(tx("📍 Я здесь (точность ~{0} м)\n{1}", Math.round(accuracy), url));
        },
        (err) => toast(err.code === 1
          ? tx("Нет доступа к геолокации — разреши его для сайта в настройках")
          : tx("Не получилось определить место, попробуй ещё раз"), true),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
      );
    }

    async sendContact() {
      try {
        const supported = await navigator.contacts.getProperties();
        const props = ["name", "tel", "email"].filter((p) => supported.includes(p));
        const [c] = await navigator.contacts.select(props, { multiple: false });
        if (!c) return;
        const lines = ["👤 " + ((c.name && c.name[0]) || tx("Контакт"))];
        for (const tel of c.tel || []) lines.push("📞 " + tel);
        for (const mail of c.email || []) lines.push("✉️ " + mail);
        await this.sendTextValue(lines.join("\n"));
      } catch {
        toast(tx("Не получилось открыть контакты"), true);
      }
    }

    // «Вставить»: картинка из буфера уходит файлом, текст попадает в поле — можно проверить перед отправкой.
    async pasteClipboard() {
      try {
        const items = await navigator.clipboard.read();
        const files = [];
        let text = "";
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            const blob = await item.getType(type);
            files.push(new File([blob], tx("Вставка {0}.{1}", new Date().toLocaleTimeString(PDI18N.locale).replace(/:/g, "-"), type.split("/")[1]), { type }));
          } else if (item.types.includes("text/plain")) {
            text += await (await item.getType("text/plain")).text();
          }
        }
        if (files.length) return this.sendFiles(files);
        if (!text.trim()) return toast(tx("В буфере ничего нет"));
        this.input.value = this.input.value ? `${this.input.value} ${text}` : text;
        this._resize();
        this.input.focus();
      } catch {
        toast(tx("Браузер не дал прочитать буфер — разреши доступ"), true);
      }
    }

    async sendText() {
      const text = this.input.value.trim();
      if (!text) return;
      const fd = new FormData();
      fd.append("text", text);
      this.input.value = "";
      this._resize();
      const ok = await this.upload(fd, null);
      if (!ok) { this.input.value = text; this._resize(); }
      this.input.focus();
    }

    async sendFiles(files) {
      if (!files.length) return;
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (total > this.maxUploadMb * 1024 * 1024) {
        toast(tx("Слишком большой размер. Лимит {0} МБ за раз", this.maxUploadMb), true);
        return;
      }
      const fd = new FormData();
      for (const f of files) fd.append("files", f, f.name || "file");
      const label = files.length === 1 ? files[0].name || tx("Файл") : tx("Файлов: {0}", files.length);
      await this.upload(fd, `${label} · ${fmtSize(total)}`);
    }

    pending(label) {
      const bar = el("div");
      const node = el("div", { class: "msg out pending" },
        el("div", { class: "bubble" }, el("div", { class: "fsize" }, tx("Отправка: ") + label),
          el("div", { class: "progress" }, bar)));
      this.list.append(node);
      this.updateEmpty();
      this.scrollDown(true);
      return { set: (p) => (bar.style.width = Math.round(p * 100) + "%"), remove: () => node.remove() };
    }

    // XMLHttpRequest вместо fetch — ради полоски прогресса на больших видео.
    upload(formData, label) {
      if (this.role === "phone" && !this.chatId) {
        toast(tx("Сначала открой чат с компьютером"), true);
        return Promise.resolve(false);
      }
      const p = label ? this.pending(label) : null;
      return new Promise((resolve) => {
        if (this.role === "phone") formData.append("chat_id", this.chatId);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/send");
        xhr.setRequestHeader("X-PD-Role", this.role);
        if (p) xhr.upload.onprogress = (e) => e.lengthComputable && p.set(e.loaded / e.total);
        xhr.onload = () => {
          p?.remove();
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
          if (xhr.status < 300) {
            data.messages.forEach((m) => this.add(m));
            resolve(true);
          } else {
            toast((data && data.detail) || tx("Ошибка отправки (") + xhr.status + ")", true);
            if (xhr.status === 401) this.opts.onClosed?.("unauthorized");
            resolve(false);
          }
        };
        xhr.onerror = () => { p?.remove(); toast(tx("Нет связи с сервером"), true); resolve(false); };
        xhr.send(formData);
      });
    }

    // ------------------------------------------------ голосовые
    async startRecording() {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        toast(tx("Запись голоса недоступна (нужен HTTPS и современный браузер)"), true);
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast(tx("Нет доступа к микрофону. Разреши его в настройках браузера"), true);
        return;
      }
      const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      const chunks = [];
      const started = Date.now();
      this.rec = { recorder, stream, send: false };
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(this.rec.timer);
        $("recBar").hidden = true;
        $("composer").hidden = false;
        const seconds = (Date.now() - started) / 1000;
        if (!this.rec.send || seconds < 0.7) return;
        const type = (recorder.mimeType || mimeType || "audio/webm").split(";")[0];
        const blob = new Blob(chunks, { type });
        this.sendVoice(blob, "voice." + (type.includes("mp4") ? "m4a" : type.split("/")[1]), seconds);
      };
      recorder.start();
      $("composer").hidden = true;
      $("recBar").hidden = false;
      $("recTime").textContent = "0:00";
      this.rec.timer = setInterval(() => {
        const s = (Date.now() - started) / 1000;
        $("recTime").textContent = fmtDuration(s);
        if (s >= 300) this.stopRecording(true); // не больше 5 минут
      }, 250);
    }

    sendVoice(blob, name, seconds) {
      const fd = new FormData();
      fd.append("voice", blob, name);
      fd.append("duration", seconds.toFixed(1));
      this.upload(fd, tx("голосовое ") + fmtDuration(seconds));
    }

    stopRecording(send) {
      if (!this.rec || this.rec.recorder.state === "inactive") return;
      this.rec.send = send;
      this.rec.recorder.stop();
    }

    // ------------------------------------------------ связь в реальном времени
    connect() {
      this.stopped = false;
      if (this.ws) { this.ws.onclose = null; this.ws.close(); }
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}${this.wsPath()}`);
      this.ws = ws;
      ws.onopen = () => {
        this.delay = 1000;
        this.opts.onConnection?.(true);
        clearInterval(this.ping);
        // Пинг раз в 25 с — иначе прокси может закрыть «молчащее» соединение.
        this.ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
        if (this.wasDisconnected) { this.wasDisconnected = false; this.opts.onResync?.(); }
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const current = !msg.chat_id || msg.chat_id === this.chatId;
        if (msg.type === "message" && current) {
          this.add(msg.message);
          if (msg.message.sender !== this.me) this.notify();
        } else if (msg.type === "deleted" && current) {
          this.remove(msg.id);
        } else if (msg.type === "closed") {
          this.stop();
          this.opts.onClosed?.(msg.reason);
          return;
        }
        this.opts.onEvent?.(msg);
      };
      ws.onclose = () => {
        clearInterval(this.ping);
        if (this.stopped) return;
        this.wasDisconnected = true;
        this.opts.onConnection?.(false);
        setTimeout(() => !this.stopped && this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 15000);
      };
    }

    wsPath() { return `/ws?role=${this.role}`; }

    stop() {
      this.stopped = true;
      clearInterval(this.ping);
      if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    }

    notify() {
      if (document.hidden) {
        this.unread++;
        document.title = `(${this.unread}) PhoneDrop`;
      }
      alerts.soft();
    }
  }

  // ------------------------------------------------ звук и баннер внутри приложения
  // Когда приложение открыто, система уведомление не показывает — сообщаем сами:
  // в открытом чате — тихий «тюк», в другом чате — баннер сверху и звук погромче.
  const alerts = (() => {
    let ctx = null;
    let last = 0;
    let lastKind = "";
    const enabled = () => { try { return localStorage.getItem("pd-sound") !== "off"; } catch { return true; } };

    // Браузер разрешает звук только после первого касания страницы.
    function unlock() {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume();
      } catch { /* без звука */ }
    }
    for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, unlock, { capture: true, passive: true });

    function play(kind) {
      if (!enabled() || document.hidden) return;
      const now = Date.now();
      if (now - last < 1200 && (kind === "soft" || lastKind === "alert")) return;  // не дребезжим
      last = now;
      lastKind = kind;
      if (navigator.vibrate) { try { navigator.vibrate(kind === "soft" ? 40 : [90, 60, 90]); } catch { /* нет вибро */ } }
      if (!ctx || ctx.state !== "running") return;
      const notes = kind === "soft" ? [[880, 0, 0.09, 0.05]] : [[784, 0, 0.13, 0.11], [1175, 0.12, 0.26, 0.11]];
      for (const [freq, start, end, vol] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = ctx.currentTime;
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + start);
        gain.gain.exponentialRampToValueAtTime(vol, t + start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + end);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + start);
        osc.stop(t + end + 0.02);
      }
    }

    function banner(data) {
      $("pdBanner")?.remove();
      const node = el("button", { id: "pdBanner", class: "pd-banner", type: "button", onclick: () => {
        node.remove();
        api_.open(data.url || "/", data);
      } },
      el("img", { src: "/static/icons/icon-192.png", alt: "" }),
      el("span", { class: "pd-banner-txt" }, el("b", {}, data.title || "PhoneDrop"), el("small", {}, data.body || "")));
      document.body.append(node);
      requestAnimationFrame(() => node.classList.add("show"));
      setTimeout(() => { node.classList.remove("show"); setTimeout(() => node.remove(), 300); }, 5000);
    }

    const samePlace = (url) => {
      const u = new URL(url || "/", location.origin);
      return u.pathname + u.search === location.pathname + location.search;
    };

    const api_ = {
      enabled,
      set(on) { try { localStorage.setItem("pd-sound", on ? "on" : "off"); } catch { /* приватный режим */ } },
      soft: () => play("soft"),
      // Страница может уточнить, какой чат сейчас на экране и как открыть чат по нажатию на баннер.
      isCurrent: (data) => samePlace(data.url),
      open: (url) => { location.href = url; },
      // Пришло от service worker: push по сообщению, пока приложение открыто.
      handle(data) {
        // Входящий звонок уже на экране (звонит своей мелодией) — баннер не нужен.
        if (String(data.tag || "").startsWith("call-") && window.PDCall && window.PDCall.busy()) return;
        if (api_.isCurrent(data)) return play("soft");
        if (!data.system) banner(data);  // на iPhone система уже показала своё уведомление
        play("alert");
      },
    };
    // Кнопки «🔊 Звук сообщений» в меню (на каждой странице свои, работают одинаково).
    const label = () => (enabled() ? tx("🔊 Звук сообщений: включён") : tx("🔇 Звук сообщений: выключен"));
    for (const btn of document.querySelectorAll("[data-sound-toggle]")) {
      btn.textContent = label();
      btn.addEventListener("click", () => {
        api_.set(!enabled());
        document.querySelectorAll("[data-sound-toggle]").forEach((b) => (b.textContent = label()));
        if (enabled()) { unlock(); setTimeout(() => play("alert"), 50); }
        toast(enabled() ? tx("Звук включён") : tx("Звук выключен"));
      });
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "pd-push") api_.handle(e.data.data || {});
      });
      if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
    }
    return api_;
  })();

  // ------------------------------------------------ push-уведомления
  const push = {
    supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,

    status() {
      if (!push.supported()) return "unsupported";
      if (Notification.permission === "denied") return "denied";
      return Notification.permission === "granted" ? "granted" : "default";
    },

    keyBytes(key) {
      const b64 = (key + "=".repeat((4 - (key.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    },

    // Подписывает этот браузер на уведомления и сообщает серверу адрес подписки.
    async subscribe(role, key) {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const wanted = push.keyBytes(key);
      if (sub) {
        const current = new Uint8Array(sub.options.applicationServerKey || []);
        if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
          await sub.unsubscribe(); // ключ сервера сменился — переподписываемся
          sub = null;
        }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
      await api(role, "/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
    },

    // Вызывается по нажатию кнопки: браузер спросит разрешение.
    async enable(role, key) {
      if (!push.supported()) throw new Error(tx("Этот браузер не поддерживает уведомления"));
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(tx("Уведомления запрещены. Разреши их в настройках браузера"));
      await push.subscribe(role, key);
    },

    // При каждом открытии: если разрешение уже есть — обновляем подписку на сервере.
    async sync(role, key) {
      if (push.status() !== "granted" || !key) return;
      try { await push.subscribe(role, key); } catch { /* попробуем в следующий раз */ }
    },
  };

  return { $, el, toast, api, fmtSize, fmtTime, fmtDuration, dayLabel, copyText, Chat, push, alerts, canShareFiles, shareFiles, prefetchShare };
})();
