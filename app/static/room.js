// PhoneDrop — «чат с человеком»: одна страница и для создателя чата, и для собеседника.
// Собеседник попадает сюда по коду (страница /get) или по ссылке-приглашению /j/<ключ>.
// Файлы любого размера (до 10 ГБ) уходят частями — как в «Передачах»: оборвалась связь —
// загрузка продолжится сама; закрыл страницу — выбираешь тот же файл, и она продолжится.
"use strict";

(() => {
  const { $, el, api, toast, fmtSize, fmtDuration, copyText, Chat, push, canShareFiles } = PD;
  const ROLE = "room";
  const mobile = matchMedia("(pointer: coarse)").matches;
  const rid = (location.pathname.match(/^\/room\/([0-9a-f]{32})$/) || [])[1] || null;
  const joinToken = (location.pathname.match(/^\/j\/([\w-]+)$/) || [])[1] || null;
  let state = null;     // ответ GET /api/rooms/<id>
  let room = null;      // state.room
  let invite = null;    // показанный код приглашения (только у создателя)
  let readTimer = null;

  function show(id) {
    for (const v of ["joinView", "errorView", "dropZone"]) $(v).hidden = v !== id;
  }

  function fail(title, text, link) {
    chat.stop();
    $("errorTitle").textContent = title;
    $("errorText").textContent = text;
    const a = $("errorLink");
    a.href = link ? link.href : "/get";
    a.textContent = link ? link.text : "🔑 Ввести код";
    show("errorView");
  }

  function backUrl() {
    if (!room || room.me === "guest") return "/get";
    return mobile ? "/chat?tab=people" : "/";
  }

  // ---------- чат: отправка через «чат с человеком»
  class RoomChat extends Chat {
    constructor(opts) {
      super(opts);
      this.queue = [];
      this.uploads = new Set();   // незаконченные отправки (их «полоски» в ленте)
      this.busy = false;
    }

    canDelete(m) { return m.sender === this.me; }
    deleteUrl(id) { return `/api/rooms/${rid}/messages/${id}`; }
    wsPath() { return `/ws?role=room&room=${rid}`; }

    setMessages(messages) {
      super.setMessages(messages);
      for (const u of this.uploads) this.list.append(u.node);  // полоски отправки остаются внизу
      this.updateEmpty();
    }

    updateEmpty() {
      const empty = $("empty");
      if (empty) empty.hidden = !!this.list.querySelector(".msg");
    }

    async sendText() {
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      this._resize();
      try {
        const { message } = await api(ROLE, `/api/rooms/${rid}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        });
        this.add(message);
      } catch (e) {
        toast(e.message, true);
        if (e.status === 404) return onClosed("unauthorized");
        this.input.value = text;
        this._resize();
      }
      this.input.focus();
    }

    sendFiles(files) {
      for (const f of files) {
        if (!f.size) { toast(`«${f.name}» пустой — пропускаю`, true); continue; }
        if (state && f.size > state.max_mb * 1024 * 1024) {
          toast(`«${f.name}» больше ${Math.round(state.max_mb / 1024)} ГБ`, true);
          continue;
        }
        this.enqueue({ file: f, name: f.name || "file", size: f.size, received: 0, kind: "file" });
      }
    }

    sendVoice(blob, name, seconds) {
      const file = new File([blob], name, { type: blob.type });
      this.enqueue({ file, name, size: file.size, received: 0, kind: "voice", duration: +seconds.toFixed(1),
        label: "🎤 Голосовое " + fmtDuration(seconds) });
    }

    // ---------- очередь отправки: файлы уходят по одному
    enqueue(u) {
      u.state = u.file ? "queued" : "lost";
      u.node = el("div", { class: "msg out pending" });
      this.uploads.add(u);
      this.list.append(u.node);
      this.paint(u);
      this.updateEmpty();
      this.scrollDown(true);
      if (u.file) { this.queue.push(u); this.pump(); }
    }

    async pump() {
      if (this.busy) return;
      this.busy = true;
      while (this.queue.length) {
        const u = this.queue.shift();
        if (u.state === "queued") await this.run(u);
      }
      this.busy = false;
    }

    async run(u) {
      if (!u.id) {
        try {
          const r = await api(ROLE, `/api/rooms/${rid}/files`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: u.name, size: u.size, mime: u.file.type, kind: u.kind, duration: u.duration }),
          });
          u.id = r.id;
        } catch (e) {
          toast(`«${u.label || u.name}»: ${e.message}`, true);
          return this.drop(u);
        }
      }
      u.state = "uploading";
      u.job = new PDUpload.ChunkUpload({
        file: u.file, size: u.size, received: u.received, chunkMb: state ? state.chunk_mb : 8,
        url: (offset) => `/api/rooms/${rid}/files/${u.id}/data?offset=${offset}`,
        status: async () => {
          try {
            return (await api(ROLE, `/api/rooms/${rid}/files/${u.id}`)).received;
          } catch (e) {
            if (e.status === 404) return null;
            throw e;
          }
        },
        onUpdate: () => { u.received = u.job.received; this.paint(u); },
      });
      let result;
      try {
        result = await u.job.run();
      } catch (e) {
        u.state = "error";
        u.error = e.message;
        this.paint(u);
        return;
      }
      if (result === "paused") { u.state = "paused"; this.paint(u); return; }
      if (result === "gone") { toast(`«${u.name}»: загрузка удалена`, true); return this.drop(u); }
      // Готово: само сообщение придёт по WebSocket, но берём его и напрямую — вдруг связь мигнула.
      this.drop(u);
      try {
        const st = await api(ROLE, `/api/rooms/${rid}/files/${u.id}`);
        if (st.message) this.add(st.message);
      } catch { /* придёт при переподключении */ }
    }

    drop(u) {
      this.uploads.delete(u);
      u.node.remove();
      this.updateEmpty();
    }

    pause(u) {
      if (u.job) u.job.pause();
    }

    resume(u) {
      u.state = "queued";
      this.paint(u);
      this.queue.push(u);
      this.pump();
    }

    async cancel(u) {
      if (u.job) u.job.pause();
      u.state = "cancelled";
      this.drop(u);
      if (u.id) {
        try { await api(ROLE, `/api/rooms/${rid}/messages/${u.id}`, { method: "DELETE" }); } catch { /* уже нет */ }
      }
    }

    pick(u) {
      PDUpload.pickSame(u.name, u.size, (file) => { u.file = file; this.resume(u); }, toast, fmtSize);
    }

    paint(u) {
      const pct = u.size ? Math.floor((u.received / u.size) * 100) : 0;
      let status;
      if (u.state === "queued") status = u.received ? `▶ продолжу · ${pct}%` : "⏳ в очереди";
      else if (u.state === "lost") status = `⏸ Отправка прервалась на ${pct}% — выбери этот же файл, чтобы продолжить`;
      else if (u.state === "error") status = `⚠️ ${u.error}`;
      else status = PDUpload.statusText(u.job, u.size, fmtSize);
      const bar = el("div");
      bar.style.width = pct + "%";
      const buttons = [];
      if (u.state === "uploading") buttons.push(el("button", { type: "button", onclick: () => this.pause(u) }, "⏸ Пауза"));
      if (u.state === "paused" || u.state === "error") {
        buttons.push(el("button", { type: "button", onclick: () => this.resume(u) }, "▶ Продолжить"));
      }
      if (u.state === "lost") buttons.push(el("button", { type: "button", onclick: () => this.pick(u) }, "📂 Выбрать файл"));
      buttons.push(el("button", { type: "button", class: "del", onclick: () => this.cancel(u) }, "Отменить"));
      u.node.replaceChildren(el("div", { class: "bubble" },
        el("div", { class: "up-name" }, u.label || u.name, el("small", {}, " · " + fmtSize(u.size))),
        el("div", { class: "progress" }, bar),
        el("div", { class: "fsize up-status" }, status),
        el("div", { class: "actions" }, ...buttons)));
    }

    busyUploading() {
      return [...this.uploads].some((u) => u.state === "uploading" || u.state === "queued");
    }
  }

  const chat = new RoomChat({
    role: ROLE,
    mobile,
    enterSends: !mobile,
    onEvent,
    onClosed,
    onResync: () => load(false),
    onConnection: (ok) => { if (!ok) $("roomStatus").textContent = "нет связи с сервером…"; else setStatus(); },
  });

  function onClosed(reason) {
    chat.stop();
    sessionStorage.removeItem("pd-inv-" + rid);
    const texts = {
      room_closed: ["Чат закрыт", "Создатель закрыл этот чат — переписка и файлы удалены."],
      idle: ["Чат закрылся сам", "В нём 30 дней никто не писал — переписка и файлы удалены."],
      replaced: ["Вход больше не работает", "В этот чат вошли по новому коду с другого устройства. Если это был не ты — попроси у собеседника новый код."],
      left: ["Ты вышел из чата", "Чтобы вернуться, попроси у собеседника новый код."],
    };
    const [title, text] = texts[reason] || ["Чат не найден",
      "Его закрыли, или ты открыл ссылку в другом браузере. Попроси у собеседника новый код."];
    const back = room && room.me === "owner" ? { href: backUrl(), text: "← К списку чатов" } : null;
    fail(title, text, back);
  }

  // ---------- шапка
  function setStatus() {
    if (!room) return;
    let text;
    if (room.me === "owner" && !room.joined) text = "ещё не вошёл — отправь ему код";
    else text = room.peer_online ? "в сети" : "не в сети";
    $("roomStatus").textContent = text;
    $("avatar").classList.toggle("online", !!room.peer_online && room.joined);
  }

  function setHeader() {
    $("roomName").textContent = room.title;
    $("avatar").textContent = (room.title.trim()[0] || "?").toUpperCase();
    document.title = `${room.title} — PhoneDrop`;
    $("backBtn").href = backUrl();
    for (const n of document.querySelectorAll(".owner-only")) n.hidden = room.me !== "owner";
    for (const n of document.querySelectorAll(".guest-only")) n.hidden = room.me !== "guest";
    setStatus();
  }

  function renderPushBanner() {
    // Создателю уведомления приходят через приложение на телефоне; собеседнику — включаем здесь.
    $("pushBanner").hidden = !(room && room.me === "guest" && push.status() === "default");
  }

  // ---------- приглашение (только у создателя)
  function fmtUntil(ts) {
    return new Date(ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  }

  function inviteText() {
    return `Привет! Давай переписываться в PhoneDrop 👋\nОткрой ссылку: ${invite.link}\n` +
      `Или зайди на ${invite.get_url} и введи код: ${invite.code}\n(код одноразовый, действует до ${fmtUntil(invite.expires)})`;
  }

  function renderInvite(force) {
    const box = $("inviteBox");
    if (!room || room.me !== "owner") { box.hidden = true; return; }
    if (invite && invite.expires * 1000 < Date.now()) invite = null;
    const visible = force || !room.joined;
    box.hidden = !visible;
    if (!visible) return;
    $("invTitle").textContent = room.joined ? "Новый код приглашения" : `Пригласи: ${room.title}`;
    $("invHas").hidden = !invite;
    $("invNone").hidden = !!invite;
    if (invite) {
      $("invGet").textContent = invite.get_url.replace(/^https?:\/\//, "");
      $("invCode").textContent = invite.code;
      $("invMeta").textContent = `Код одноразовый, действует до ${fmtUntil(invite.expires)}` +
        (room.joined ? ". Кто войдёт по нему — заменит нынешнего собеседника" : "");
    } else {
      $("invNoneText").textContent = room.invite_expires
        ? `Код уже выдан и действует до ${fmtUntil(room.invite_expires)}. Потерял его? Получи новый — старый перестанет работать.`
        : room.joined
          ? "Собеседник сменил телефон или браузер? Получи новый код — после входа по нему старый вход перестанет работать."
          : "Получи код и продиктуй или отправь его собеседнику.";
      $("invMake").textContent = room.invite_expires || room.joined ? "🔑 Получить новый код" : "🔑 Получить код";
    }
  }

  async function makeInvite() {
    try {
      invite = await api(ROLE, `/api/rooms/${rid}/invite`, { method: "POST" });
      room.invite_expires = invite.expires;
      sessionStorage.setItem("pd-inv-" + rid, JSON.stringify(invite));
    } catch (e) {
      return toast(e.message, true);
    }
    renderInvite(true);
  }

  $("invMake").addEventListener("click", makeInvite);
  $("invCopy").addEventListener("click", () => copyText(inviteText()));
  $("invShare").addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({ text: inviteText() }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    copyText(inviteText());
  });
  $("invHide").addEventListener("click", () => { $("inviteBox").hidden = true; });

  // ---------- загрузка чата
  async function load(first = true) {
    try {
      state = await api(ROLE, `/api/rooms/${rid}`);
    } catch (e) {
      if (e.status === 404 || e.status === 403) return onClosed("unauthorized");
      if (first) return fail("Нет связи", "Не получилось открыть чат. Проверь интернет и обнови страницу.", { href: location.href, text: "Обновить" });
      return;
    }
    room = state.room;
    chat.me = room.me;       // «мои» сообщения — справа
    chat.chatId = rid;
    setHeader();
    chat.setMessages(state.messages);
    if (first) {
      // Незаконченные отправки (страницу закрыли посреди загрузки) — можно продолжить.
      for (const up of state.uploads) {
        chat.enqueue({ id: up.id, name: up.name, size: up.size, received: up.received, kind: up.kind,
          label: up.kind === "voice" ? "🎤 Голосовое" : null });
      }
      $("emptyText").textContent = `Напиши сообщение, отправь фото, голосовое или файл (до ${Math.round(state.max_mb / 1024)} ГБ). ` +
        `Файлы хранятся ${state.file_ttl_hours} ч, текст — пока чат не закроют.`;
    }
    renderInvite(false);
    renderPushBanner();
  }

  function markRead() {
    clearTimeout(readTimer);
    if (!room || document.hidden) return;
    readTimer = setTimeout(() => api(ROLE, `/api/rooms/${rid}/read`, { method: "POST" }).catch(() => {}), 400);
  }
  document.addEventListener("visibilitychange", markRead);

  function onEvent(msg) {
    if (!room) return;
    if (msg.type === "message" && msg.message.sender !== room.me) {
      markRead();
    } else if (msg.type === "presence") {
      room.peer_online = room.me === "owner" ? msg.guest_online : msg.owner_online;
      setStatus();
    } else if (msg.type === "joined") {
      room.joined = true;
      room.invite_expires = null;
      invite = null;
      sessionStorage.removeItem("pd-inv-" + rid);
      $("inviteBox").hidden = true;
      toast(`✅ ${room.title} вошёл в чат`);
      setStatus();
    } else if (msg.type === "left") {
      room.joined = false;
      toast(`${room.title} вышел из чата`);
      setStatus();
      renderInvite(false);
    }
  }

  // ---------- меню
  $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; });
  document.addEventListener("click", () => { $("menu").hidden = true; });

  $("menuInvite").addEventListener("click", () => renderInvite(true));

  $("menuRename").addEventListener("click", async () => {
    const title = prompt("Как назвать собеседника?", room.title);
    if (!title || !title.trim()) return;
    try {
      room.title = (await api(ROLE, `/api/rooms/${rid}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
      })).title;
      setHeader();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $("menuClose").addEventListener("click", async () => {
    if (!confirm(`Закрыть чат с «${room.title}»? Вся переписка и файлы удалятся у вас обоих.`)) return;
    try {
      await api(ROLE, `/api/rooms/${rid}`, { method: "DELETE" });
    } catch (e) {
      return toast(e.message, true);
    }
    location.href = backUrl();
  });

  $("menuLeave").addEventListener("click", async () => {
    if (!confirm("Выйти из чата? Вернуться можно будет только по новому коду от собеседника.")) return;
    try {
      await api(ROLE, `/api/rooms/${rid}/leave`, { method: "POST" });
    } catch (e) {
      return toast(e.message, true);
    }
    location.href = "/get";
  });

  $("menuInfo").addEventListener("click", () => {
    const hours = state ? state.file_ttl_hours : 24;
    const days = state ? state.idle_days : 30;
    alert(`🔒 Как хранится переписка\n\n• Текст — пока чат не закроют.\n• Фото, голосовые и файлы — ${hours} ч, потом удаляются сами.\n` +
      `• Если в чате ${days} дней никто не пишет, он закрывается сам.\n• Файлы видите только вы двое.`);
  });

  async function enablePush() {
    try {
      await push.enable(ROLE, state.vapid_key);
      toast("Уведомления включены");
    } catch (e) {
      toast(e.message, true);
    }
    renderPushBanner();
  }
  $("pushBannerBtn").addEventListener("click", enablePush);
  $("menuPush").addEventListener("click", () => {
    const status = push.status();
    if (status === "granted") toast("Уведомления уже включены ✅");
    else if (status === "unsupported") toast("Этот браузер не поддерживает уведомления", true);
    else if (status === "denied") toast("Уведомления запрещены. Разреши их в настройках сайта", true);
    else enablePush();
  });

  // Не даём случайно закрыть страницу посреди отправки файла.
  window.addEventListener("beforeunload", (e) => {
    if (chat.busyUploading()) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------- вход по ссылке-приглашению
  async function startJoin() {
    show("joinView");
    let info;
    try {
      info = await api(ROLE, `/api/rooms/invite/${joinToken}`);
    } catch (e) {
      return fail("Приглашение не работает", e.message);
    }
    if (info.mine) {
      $("joinTitle").textContent = "Это твоё приглашение";
      $("joinText").textContent = "Отправь эту ссылку собеседнику — войти по ней должен он, а не ты.";
      $("joinBtn").hidden = true;
      return;
    }
    $("joinTitle").textContent = `${info.owner_name} приглашает тебя в чат`;
    $("joinBtn").addEventListener("click", async () => {
      $("joinBtn").disabled = true;
      try {
        const r = await api(ROLE, "/api/rooms/join", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: joinToken }),
        });
        location.replace(`/room/${r.room}`);
      } catch (e) {
        $("joinBtn").disabled = false;
        fail("Приглашение не работает", e.message);
      }
    });
  }

  async function start() {
    if (joinToken) return startJoin();
    if (!rid) return fail("Чат не найден", "Неверная ссылка.");
    try { invite = JSON.parse(sessionStorage.getItem("pd-inv-" + rid) || "null"); } catch { invite = null; }
    await load(true);
    if (!room) return;
    show("dropZone");
    chat.connect();
    if (room.me === "guest") push.sync(ROLE, state.vapid_key);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    const params = new URLSearchParams(location.search);
    if (params.has("invite")) {
      history.replaceState(null, "", location.pathname);
      if (room.me === "owner" && !room.joined && !invite) await makeInvite();
    }
    if (!canShareFiles && !navigator.share) $("invShare").hidden = true;
    markRead();
  }

  start();
})();
