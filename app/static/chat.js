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
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1024 ** 2) return Math.round(bytes / 1024) + " КБ";
    if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " МБ";
    return (bytes / 1024 ** 3).toFixed(2) + " ГБ";
  }

  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function dayLabel(ts) {
    const d = new Date(ts * 1000);
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return "Сегодня";
    if (d.toDateString() === yesterday.toDateString()) return "Вчера";
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  async function api(role, path, options = {}) {
    const headers = Object.assign({ "X-PD-Role": role }, options.headers || {});
    const response = await fetch(path, Object.assign({}, options, { headers, credentials: "same-origin" }));
    let data = null;
    try { data = await response.json(); } catch { /* пустой ответ */ }
    if (!response.ok) {
      const error = new Error((data && data.detail) || `Ошибка ${response.status}`);
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
    toast("Скопировано");
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
      toast("Картинка скопирована — вставляй через Ctrl+V");
    } catch {
      toast("Браузер не дал скопировать картинку. Скачай её", true);
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
    if (!response.ok) throw new Error("Файл больше недоступен");
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
      toast("Этот тип файла нельзя отправить через «Поделиться» — скачай его", true);
      return;
    }
    try {
      await navigator.share({ files });
    } catch (e) {
      if (e.name !== "AbortError") toast("Нажми «Поделиться» ещё раз", true);
    }
  }

  async function shareFiles(items) {
    const ready = items.map((i) => shareCache.get(i.url));
    if (ready.every(Boolean)) return share(ready);
    const started = Date.now();
    toast("Готовлю файл…");
    let files;
    try {
      files = await Promise.all(items.map(fetchFile));
    } catch (e) {
      return toast(e.message, true);
    }
    // Если скачивание заняло долго, браузер уже «забыл» нажатие — просим нажать ещё раз.
    if (Date.now() - started < 3000) return share(files);
    toast("Файл готов — нажми «Поделиться» ещё раз");
  }

  class Chat {
    constructor(opts) {
      this.opts = opts;
      this.role = opts.role;
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
      if (day !== this.lastDay) {
        this.list.append(el("div", { class: "day" }, day));
        this.lastDay = day;
      }
      const node = this.render(m);
      if (!animate) node.style.animation = "none";
      this.list.append(node);
      this.updateEmpty();
      this.scrollDown(m.sender === this.role);
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
      const mine = m.sender === this.role;
      const bubble = el("div", { class: "bubble kind-" + m.kind });
      const actions = el("div", { class: "actions" });

      if (m.kind === "text") {
        bubble.append(el("div", { class: "text", dir: "auto" }, linkify(m.text)));
        actions.append(el("button", { type: "button", onclick: () => copyText(m.text) }, "Копировать"));
      } else if (m.expired) {
        bubble.append(el("div", { class: "expired-file" },
          (m.kind === "voice" ? "🎤 Голосовое" : "📎 " + m.name) + " — удалено, срок хранения истёк"));
      } else if (m.kind === "voice") {
        bubble.append(
          el("div", { class: "voice-label" }, "🎤 Голосовое" + (m.duration ? " · " + fmtDuration(m.duration) : "")),
          el("audio", { controls: true, preload: "metadata", src: m.url })
        );
        actions.append(el("a", { href: m.download_url, download: m.name }, "Скачать"));
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
            ? { href: openUrl, target: "_blank", rel: "noopener", title: "Открыть" }
            : { href: m.download_url, download: m.name, title: "Скачать" };
          bubble.append(el("a", { class: "file-row", ...open },
            el("div", { class: "ext" }, ext),
            el("div", { class: "finfo" },
              el("div", { class: "fname" }, m.name),
              el("div", { class: "fsize" }, fmtSize(m.size) + (openUrl ? " · нажми, чтобы открыть" : "")))));
        }
        if (m.viewable && !mime.startsWith("video/") && !mime.startsWith("audio/")) {
          actions.append(el("a", { href: m.url, target: "_blank", rel: "noopener" }, "Открыть"));
        } else if (m.preview_url) {
          actions.append(el("a", { href: m.preview_url, target: "_blank", rel: "noopener" }, "Открыть"));
        }
        actions.append(el("a", { href: m.download_url, download: m.name }, "Скачать"));
        if (m.convert_to) {
          const btn = el("button", { type: "button", onclick: () => this.convertMessage(m.id, btn) },
            m.convert_to === "pdf" ? "В PDF" : "В JPG");
          actions.append(btn);
        }
        if (this.role === "phone" && canShareFiles) {
          actions.append(el("button", { type: "button",
            onclick: () => shareFiles([{ url: m.url, name: m.name, mime: m.mime }]) }, "Поделиться"));
        }
        if (IMG_RE.test(mime) && window.ClipboardItem && this.role === "pc") {
          actions.append(el("button", { type: "button", onclick: () => copyImage(m.url) }, "Копировать картинку"));
        }
      }

      actions.append(el("button", { type: "button", class: "del", onclick: () => this.deleteMessage(m.id) }, "Удалить"));
      bubble.append(actions);
      bubble.append(el("div", { class: "meta" }, fmtTime(m.created), mine ? el("span", { class: "tick" }, "✓✓") : null));
      return el("div", { class: "msg " + (mine ? "out" : "in"), id: "m-" + m.id }, bubble);
    }

    async convertMessage(id, btn) {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Конвертирую…";
      try {
        await api(this.role, `/api/messages/${id}/convert`, { method: "POST" });
        toast("Готово — новый файл в чате");
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }

    async deleteMessage(id) {
      try {
        await api(this.role, "/api/messages/" + id, { method: "DELETE" });
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
        this.actionBtn.setAttribute("aria-label", input.value.trim() ? "Отправить" : "Записать голосовое");
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
      $("attachBtn").addEventListener("click", () => $("fileInput").click());
      $("fileInput").addEventListener("change", (e) => {
        this.sendFiles([...e.target.files]);
        e.target.value = "";
      });
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
        if (!files.length) return;
        e.preventDefault();
        this.sendFiles(files);
      });
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
        toast(`Слишком большой размер. Лимит ${this.maxUploadMb} МБ за раз`, true);
        return;
      }
      const fd = new FormData();
      for (const f of files) fd.append("files", f, f.name || "file");
      const label = files.length === 1 ? files[0].name || "Файл" : `Файлов: ${files.length}`;
      await this.upload(fd, `${label} · ${fmtSize(total)}`);
    }

    pending(label) {
      const bar = el("div");
      const node = el("div", { class: "msg out pending" },
        el("div", { class: "bubble" }, el("div", { class: "fsize" }, "Отправка: " + label),
          el("div", { class: "progress" }, bar)));
      this.list.append(node);
      this.updateEmpty();
      this.scrollDown(true);
      return { set: (p) => (bar.style.width = Math.round(p * 100) + "%"), remove: () => node.remove() };
    }

    // XMLHttpRequest вместо fetch — ради полоски прогресса на больших видео.
    upload(formData, label) {
      if (this.role === "phone" && !this.chatId) {
        toast("Сначала открой чат с компьютером", true);
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
            toast((data && data.detail) || "Ошибка отправки (" + xhr.status + ")", true);
            if (xhr.status === 401) this.opts.onClosed?.("unauthorized");
            resolve(false);
          }
        };
        xhr.onerror = () => { p?.remove(); toast("Нет связи с сервером", true); resolve(false); };
        xhr.send(formData);
      });
    }

    // ------------------------------------------------ голосовые
    async startRecording() {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        toast("Запись голоса недоступна (нужен HTTPS и современный браузер)", true);
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast("Нет доступа к микрофону. Разреши его в настройках браузера", true);
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
        const fd = new FormData();
        fd.append("voice", blob, "voice." + (type.includes("mp4") ? "m4a" : type.split("/")[1]));
        fd.append("duration", seconds.toFixed(1));
        this.upload(fd, "голосовое " + fmtDuration(seconds));
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
      const ws = new WebSocket(`${proto}://${location.host}/ws?role=${this.role}`);
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
          if (msg.message.sender !== this.role) this.notify();
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
      if (this.role === "phone" && navigator.vibrate) navigator.vibrate(60);
    }
  }

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
      if (!push.supported()) throw new Error("Этот браузер не поддерживает уведомления");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Уведомления запрещены. Разреши их в настройках браузера");
      await push.subscribe(role, key);
    },

    // При каждом открытии: если разрешение уже есть — обновляем подписку на сервере.
    async sync(role, key) {
      if (push.status() !== "granted" || !key) return;
      try { await push.subscribe(role, key); } catch { /* попробуем в следующий раз */ }
    },
  };

  return { $, el, toast, api, fmtSize, fmtTime, Chat, push, canShareFiles, shareFiles, prefetchShare };
})();
