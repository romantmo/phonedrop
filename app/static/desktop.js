// PhoneDrop — компьютер: QR-код, режим «чужой/мой», уведомления и общий список чатов:
// телефон, другие мои компьютеры (большие файлы) и люди (чаты по коду, открываются в новой вкладке).
"use strict";

(() => {
  const { $, el, api, toast, Chat, push } = PD;
  const ROLE = "pc";
  let state = null;
  let pairTimer = null;
  let starting = false;

  const chat = new Chat({
    role: ROLE,
    enterSends: true, // на компьютере Enter — отправить, Shift+Enter — новая строка
    onEvent,
    onClosed,
    onResync: resync,
    onConnection: (ok) => { if (!ok) setPeer("нет связи с сервером…"); },
  });

  const setPeer = (text) => ($("peerStatus").textContent = text);

  function render() {
    const linked = state.linked;
    const remember = state.device.mode === "remember";
    $("pairBox").hidden = linked;
    $("composer").hidden = !linked;
    $("logoutBtn").hidden = !linked;
    $("relinkBtn").hidden = !(linked && remember);
    $("tabs").hidden = !linked;  // чаты и инструменты — только для подключённого к телефону компьютера
    if (!linked) { showSection("chat"); selectChat("phone"); }
    $("chatsCard").hidden = !linked || section !== "chat";
    renderChats();
    if (document.activeElement !== $("deviceName")) {
      $("deviceName").value = state.device.label;
      $("saveNameBtn").hidden = true;
    }
    for (const radio of document.querySelectorAll("input[name=mode]")) radio.checked = radio.value === state.device.mode;
    $("rememberHint").textContent =
      `Запомнить его. Переписка сохраняется, файлы хранятся ${state.file_ttl_days} дней`;
    $("noteText").textContent = remember
      ? "🏠 Выбирай только для своего компьютера: любой, кто сядет за него, увидит переписку. Отключить можно кнопкой ниже или с телефона."
      : "🔒 Когда закроешь вкладку, через минуту переписка и файлы удалятся с сервера. Скачанные файлы остаются в «Загрузках» — на чужом компьютере удаляй их сам.";
    $("emptyIcon").textContent = linked ? "💬" : "📷";
    $("emptyTitle").textContent = linked ? "Пока пусто" : "Отсканируй QR-код слева";
    $("emptyText").textContent = linked
      ? "Отправь с телефона фото, файл, текст или голосовое. Отсюда тоже можно: перетащи файл в окно или нажми Ctrl+V."
      : "Наведи камеру телефона на код — и можно переписываться.";
    setPeer(!linked ? "не подключён" : state.phone_online ? "в сети" : "не в сети — сообщения дождутся");
    renderPush();
  }

  function renderPush() {
    const status = push.status();
    $("pushBox").hidden = !state.linked || status === "unsupported";
    $("pushBtn").hidden = status !== "default";
    $("pushText").textContent = status === "granted"
      ? "✅ Включены. Придут, даже когда вкладка свёрнута."
      : status === "denied"
        ? "Запрещены в настройках браузера. Разреши их через значок замка в адресной строке."
        : "Узнавай о сообщениях с телефона, даже когда вкладка свёрнута.";
  }

  function showPair(pair) {
    clearInterval(pairTimer);
    // SVG-код QR сгенерирован нашим же сервером из нашей ссылки — пользовательских данных в нём нет.
    $("qr").innerHTML = pair.qr_svg;
    const until = Date.now() + pair.expires_in * 1000;
    const tick = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      $("pairExpires").textContent = `Код действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (left === 0) {
        clearInterval(pairTimer);
        newPairCode(); // пока телефон не подключён — код обновляется сам
      }
    };
    tick();
    pairTimer = setInterval(tick, 1000);
  }

  async function newPairCode() {
    try {
      const { pair } = await api(ROLE, "/api/pc/pair", { method: "POST" });
      showPair(pair);
    } catch (e) {
      if (e.status === 401 || e.status === 409) start();
      else toast(e.message, true);
    }
  }

  async function start() {
    if (starting) return;
    starting = true;
    try {
      state = await api(ROLE, "/api/pc/session", { method: "POST" });
      chat.chatId = state.chat_id;
      chat.maxUploadMb = state.max_upload_mb;
      chat.setMessages(state.messages || []);
      if (state.pair) showPair(state.pair);
      else clearInterval(pairTimer);
      $("pcGoogle").hidden = !(state.google && !state.linked);
      render();
      chat.connect();
      if (state.linked) { push.sync(ROLE, state.vapid_key); PDPcChat.refresh(); PDPeople.refresh(); }
    } catch (e) {
      toast(e.message, true);
      setTimeout(start, 5000);
    } finally {
      starting = false;
    }
  }

  async function resync() {
    if (!state || !state.linked) return start();
    try {
      Object.assign(state, await api(ROLE, "/api/state"));
      chat.setMessages(state.messages);
      render();
    } catch (e) {
      if (e.status === 401) onClosed("unauthorized");
    }
  }

  function onEvent(msg) {
    if (msg.type === "linked") {
      toast("Телефон подключён");
      start();
    } else if (msg.type === "transfers_changed") {
      PDPcChat.refresh();
    } else if (msg.type === "rooms_changed") {
      PDPeople.refreshSoon();
    } else if (msg.type === "relinked") {
      closeRelink();
      toast("Телефон переподключён — все чаты на нём");
    } else if (msg.type === "presence") {
      state.phone_online = msg.phone_online;
      render();
    } else if (msg.type === "renamed") {
      state.device.label = msg.label; // переименовали с телефона
      render();
    }
  }

  function onClosed(reason) {
    chat.stop();
    clearInterval(pairTimer);
    const texts = {
      phone_removed: "Телефон отключил этот компьютер — переписка удалена",
      expired: "Компьютер долго не использовался и был отключён",
      reattached: "Готово — переписка восстановлена",
      moved: "Этот чат открыли в другом браузере — здесь он отключён",
    };
    if (texts[reason]) toast(texts[reason]);
    start();
  }

  // ---------- режим «чужой / мой»
  for (const radio of document.querySelectorAll("input[name=mode]")) {
    radio.addEventListener("change", async () => {
      if (!radio.checked || !state) return;
      try {
        await api(ROLE, "/api/pc/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: radio.value }),
        });
        state.device.mode = radio.value;
        toast(radio.value === "remember" ? "Компьютер запомнен" : "Переписка удалится после закрытия вкладки");
      } catch (e) {
        toast(e.message, true);
      }
      render();
    });
  }

  // ---------- название компьютера
  const nameInput = $("deviceName");
  nameInput.addEventListener("input", () => {
    $("saveNameBtn").hidden = !nameInput.value.trim() || nameInput.value.trim() === state.device.label;
  });
  async function saveName() {
    const name = nameInput.value.trim();
    if (!name || name === state.device.label) return;
    try {
      const { label } = await api(ROLE, "/api/pc/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      state.device.label = label;
      nameInput.blur();
      toast("Название сохранено");
    } catch (e) {
      toast(e.message, true);
    }
    render();
  }
  $("saveNameBtn").addEventListener("click", saveName);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); });
  nameInput.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== $("saveNameBtn")) render();
  }, 150));

  $("pushBtn").addEventListener("click", async () => {
    try {
      await push.enable(ROLE, state.vapid_key);
      toast("Уведомления включены");
    } catch (e) {
      toast(e.message, true);
    }
    renderPush();
  });

  // ---------- вкладки «Чаты | Инструменты»
  let section = "chat";
  let target = "phone";  // открытый чат: "phone" или id другого моего компьютера
  function showSection(name) {
    section = name;
    $("dropZone").hidden = name !== "chat" || target !== "phone";
    $("pcMain").hidden = name !== "chat" || target === "phone";
    $("toolsMain").hidden = name !== "tools";
    $("chatsCard").hidden = !(state && state.linked) || name !== "chat";
    for (const [id, value] of [["tabChat", "chat"], ["tabTools", "tools"]]) {
      $(id).classList.toggle("on", section === value);
      $(id).setAttribute("aria-selected", String(section === value));
    }
    if (name === "tools" && $("toolView").hidden) showToolsHome();
  }

  function selectChat(id) {
    target = PDPcChat.devices().some((d) => d.id === id) ? id : "phone";
    if (target === "phone") PDPcChat.hide();
    else PDPcChat.show(target);
    showSection("chat");
    renderChats();
  }

  // Общий список чатов слева.
  const monitorIco = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "ico");
    svg.innerHTML = '<rect x="2.5" y="4" width="19" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 20.5h7M12 16.5v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    return svg;
  };
  function row(attrs, ava, title, sub, online, badge) {
    return el(attrs.href ? "a" : "button", Object.assign({ class: "pc-row" + (attrs.on ? " on" : "") }, attrs.href
      ? { href: attrs.href, target: "_blank", rel: "noopener" } : { type: "button", onclick: attrs.onclick }),
    el("span", { class: "pc-ava" }, ava, online ? el("span", { class: "online" }) : null),
    el("span", { class: "pc-txt" }, el("b", {}, title), el("small", {}, sub)),
    badge ? el("span", { class: "pc-badge" }, badge) : null);
  }
  function renderChats() {
    if (!state || !state.linked) return;
    const pcs = PDPcChat.devices();
    const rooms = PDPeople.rooms();
    const items = [
      el("div", { class: "pc-sec" }, "📱 Телефон"),
      row({ on: target === "phone", onclick: () => selectChat("phone") }, "📱", "Мой телефон",
        state.phone_online ? "в сети" : "не в сети", state.phone_online),
      el("div", { class: "pc-sec" }, "💻 Мои компьютеры"),
    ];
    if (!pcs.length) {
      items.push(el("p", { class: "pc-hint" }, "Открой PhoneDrop на другом компьютере и подключи тем же телефоном — сможешь кидать файлы до 10 ГБ."));
    }
    for (const d of pcs) {
      items.push(row({ on: target === d.id, onclick: () => selectChat(d.id) }, monitorIco(), d.label,
        d.online ? "в сети" : "не в сети", d.online, PDPcChat.unread(d.id) ? "•" : ""));
    }
    items.push(el("div", { class: "pc-sec" }, "👥 Люди"));
    if (!rooms.length) items.push(el("p", { class: "pc-hint" }, "Переписка и файлы с кем угодно — по коду, без регистрации."));
    for (const r of rooms) {
      items.push(row({ href: PDPeople.url(r.id) }, (r.title.trim()[0] || "?").toUpperCase(), r.title,
        PDPeople.preview(r), r.online, r.unread ? String(r.unread) : ""));
    }
    $("pcList").replaceChildren(...items);
  }
  PDPcChat.onChange(() => {
    if (target !== "phone" && !PDPcChat.devices().some((d) => d.id === target)) selectChat("phone");
    else renderChats();
  });
  PDPeople.onChange(renderChats);
  PDPcChat.onIncoming((t) => toast(`📦 Пришёл файл «${t.name}» с «${t.from_label}»`));
  $("pcNewPerson").addEventListener("click", () => PDPeople.askNewChat());
  // Статусы «в сети» у других компьютеров и людей обновляем раз в 30 секунд.
  setInterval(() => {
    if (state && state.linked && !document.hidden) { PDPcChat.refresh(); PDPeople.refresh(); }
  }, 30000);

  function showToolsHome() {
    $("toolView").hidden = true;
    $("toolsHome").hidden = false;
    $("toolBack").hidden = true;
    $("toolIcon").textContent = "🛠";
    $("toolTitle").textContent = "Инструменты";
    $("toolSub").textContent = "Сканер и конвертеры. Готовый файл можно скачать или отправить на телефон";
    PDTools.renderHome($("toolsHome"), openTool);
  }
  function openTool(id) {
    if (!PDTools.open(id)) return;
    $("toolsHome").hidden = true;
    $("toolView").hidden = false;
    $("toolBack").hidden = false;
  }
  $("tabChat").addEventListener("click", () => showSection("chat"));
  $("tabTools").addEventListener("click", () => showSection("tools"));
  $("toolBack").addEventListener("click", showToolsHome);

  // ---------- «Переподключить телефон» (телефон переустановили или сменили)
  let relinkTimer = null;
  function closeRelink() {
    clearInterval(relinkTimer);
    $("relinkModal").hidden = true;
    $("relinkQr").replaceChildren();
  }
  $("relinkBtn").addEventListener("click", async () => {
    let pair;
    try {
      ({ pair } = await api(ROLE, "/api/pc/relink", { method: "POST" }));
    } catch (e) {
      return toast(e.message, true);
    }
    // SVG-код QR сгенерирован нашим же сервером из нашей ссылки — пользовательских данных в нём нет.
    $("relinkQr").innerHTML = pair.qr_svg;
    $("relinkModal").hidden = false;
    const until = Date.now() + pair.expires_in * 1000;
    const tick = () => {
      const left = Math.max(0, Math.round((until - Date.now()) / 1000));
      $("relinkExpires").textContent = left
        ? `Код действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
        : "Код истёк — закрой и нажми кнопку ещё раз";
      if (!left) clearInterval(relinkTimer);
    };
    clearInterval(relinkTimer);
    tick();
    relinkTimer = setInterval(tick, 1000);
  });
  $("relinkClose").addEventListener("click", closeRelink);
  $("relinkModal").addEventListener("click", (e) => { if (e.target === $("relinkModal")) closeRelink(); });

  $("logoutBtn").addEventListener("click", async () => {
    if (!confirm("Отключить этот компьютер? Переписка с телефоном и файлы удалятся с сервера.")) return;
    chat.stop();
    try { await api(ROLE, "/api/pc/logout", { method: "POST" }); } catch { /* уже отключён */ }
    toast("Компьютер отключён, всё удалено");
    start();
  });

  // После входа через Google сервер возвращает сюда с ?login=ok или ?login_error=…
  const q = new URLSearchParams(location.search);
  if (q.get("login_error")) toast(q.get("login_error"), true);
  else if (q.get("login") === "ok") toast("Вход выполнен — компьютер подключён ✅");
  if (q.has("login") || q.has("login_error")) history.replaceState(null, "", "/");

  start();
})();
