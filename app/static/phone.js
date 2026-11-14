// PhoneDrop — телефон: общий список чатов (компьютеры и люди), подключение по QR, инструменты, уведомления.
"use strict";

(() => {
  const { $, el, api, toast, fmtTime, Chat, push } = PD;
  const ROLE = "phone";
  const params = new URLSearchParams(location.search);
  let info = null; // общие настройки с сервера (ключ уведомлений, лимиты)
  let chats = [];
  let openId = null;
  let installEvent = null;
  let reloadTimer = null;
  let tab = "chats"; // вкладка на главном экране: «Чаты» или «Инструменты»
  // Собеседник по коду (без своего аккаунта): те же «Чаты | Инструменты», но только его чаты с людьми.
  let guest = null;   // { rooms, vapid_key } в режиме гостя

  const chat = new Chat({
    role: ROLE,
    enterSends: false, // на телефоне Enter — новая строка, отправка кнопкой
    onEvent,
    onClosed: (reason) => reason === "relinked"
      ? showGate(tx("Чаты открыты на другом телефоне"),
        tx("Если это был не ты — на своём компьютере нажми «📱 Переподключить телефон» и отсканируй код этим телефоном."))
      : showGate(),
    onResync: async () => { await loadChats(); if (openId) openChat(openId, false); },
    onConnection: (ok) => { if (!ok && openId) $("pcStatus").textContent = tx("нет связи с сервером…"); },
  });

  // Нажали на баннер о новом сообщении: чат с компьютером открываем здесь же, чат с человеком — его страницей.
  PD.alerts.open = (url) => {
    const u = new URL(url, location.origin);
    if (u.pathname === "/chat" && u.searchParams.get("c")) openChat(u.searchParams.get("c"));
    else location.href = u.pathname + u.search;
  };

  // ---------- экраны
  function showGate(title, text) {
    chat.stop();
    openId = chat.chatId = null;
    $("chatView").hidden = $("toolView").hidden = true;
    $("listView").hidden = false;
    $("chatList").hidden = $("fabAdd").hidden = $("pushBanner").hidden = $("googleBanner").hidden = true;
    $("tabs").hidden = $("toolsHome").hidden = true;
    $("gate").hidden = false;
    $("gateTitle").textContent = title || tx("Добро пожаловать");
    $("gateText").textContent = text || tx("Войди через Google — и пользуйся без компьютера. Или открой PhoneDrop на своём компьютере и отсканируй QR-код.");
    // Кнопку Google показываем, только если вход через Google настроен на сервере.
    fetch("/api/login-info").then((r) => r.json()).then((d) => { $("gateGoogle").hidden = !d.google; }).catch(() => {});
    $("gateInstall").hidden = !installEvent;
  }

  // SVG-значок монитора берём из <template> в HTML (одинаково выглядит на всех телефонах).
  const monitorIcon = () => $("icoMonitor").content.firstElementChild.cloneNode(true);

  // Плавный переход между экранами: чат «въезжает» справа, список — обратно слева.
  function animateView(id, direction) {
    const view = $(id);
    view.classList.remove("enter-forward", "enter-back");
    void view.offsetWidth; // перезапуск анимации
    view.classList.add(direction === "back" ? "enter-back" : "enter-forward");
  }

  function modeText(c) {
    return c.mode === "remember" ? tx("🔒 постоянный — переписка хранится") : tx("⏳ временный — удалится после закрытия");
  }
  const PLACES = [["home", tx("🏠 Дом")], ["work", tx("🏢 Работа")], ["", tx("💻 Другие компьютеры")]];

  function setTab(name) {
    tab = name;
    for (const [id, value] of [["tabChats", "chats"], ["tabTools", "tools"]]) {
      $(id).classList.toggle("on", tab === value);
      $(id).setAttribute("aria-selected", String(tab === value));
    }
    renderList();
  }
  $("tabChats").addEventListener("click", () => setTab("chats"));
  $("tabTools").addEventListener("click", () => setTab("tools"));
  PDPeople.onChange(() => { if (!openId && tab === "chats" && $("gate").hidden) renderList(); });

  function renderList() {
    $("gate").hidden = true;
    $("tabs").hidden = false;
    const tools = tab === "tools";
    $("toolsHome").hidden = !tools;
    $("chatList").hidden = $("fabAdd").hidden = tools;
    $("listView").querySelector(".status").textContent = tools ? tx("инструменты") : tx("чаты");
    const acc = !guest && info && info.account;
    $("googleBanner").hidden = !(info && info.google && acc && !acc.google);
    $("pushBanner").hidden = tools || !$("googleBanner").hidden || !((chats.length || guest) && push.status() === "default");
    $("menuAccount").hidden = guest ? !guest.google : !(info && info.google);
    $("menuAccount").textContent = guest ? tx("🔐 Войти через Google") : acc && acc.google ? tx("👤 {0} · выйти", acc.email) : tx("🔐 Привязать Google");
    $("menuUsers").hidden = !(acc && acc.admin);
    if (tools) {
      PDTools.renderHome($("toolsHome"), (id) => openTool(id));
      return;
    }
    const rooms = guest ? guest.rooms : PDPeople.rooms();
    const list = $("chatList");
    list.replaceChildren();
    if (guest) {  // собеседник по коду: только его чаты с людьми
      list.append(el("div", { class: "ci-section" }, tx("👥 Мои чаты")));
      for (const r of rooms) list.append(roomRow(r));
      return;
    }
    if (!chats.length && !rooms.length) {
      list.append(el("div", { class: "empty list-empty" },
        el("div", { class: "big" }, "💬"), el("b", {}, tx("Пока нет чатов")),
        tx("Нажми ＋ внизу: подключи свой компьютер по QR-коду или начни чат с человеком по коду.")));
      return;
    }
    // Компьютеры — по местам: дом, работа, остальные
    if (!chats.length) {
      list.append(el("div", { class: "ci-section" }, tx("💻 Мои компьютеры")));
      list.append(el("p", { class: "ci-hint" }, tx("Нажми ＋ внизу → «Мой компьютер» и отсканируй QR-код на экране компьютера.")));
    }
    const grouped = PLACES.filter(([key]) => chats.some((c) => (c.place || "") === key));
    for (const [key, title] of grouped) {
      list.append(el("div", { class: "ci-section" }, grouped.length === 1 && !key ? tx("💻 Мои компьютеры") : title));
      for (const c of chats.filter((x) => (x.place || "") === key)) {
        const preview = c.last ? (c.last.sender === "phone" ? tx("Вы: ") : "") + c.last.preview : modeText(c);
        list.append(el("button", { class: "chat-item", type: "button", onclick: () => openChat(c.id) },
          el("div", { class: "avatar" }, monitorIcon(), c.pc_online ? el("span", { class: "online" }) : null),
          el("div", { class: "ci-main" },
            el("div", { class: "ci-row" },
              el("span", { class: "ci-name" }, c.label),
              el("span", { class: "ci-time" }, c.last ? fmtTime(c.last.created) : "")),
            el("div", { class: "ci-row" },
              el("span", { class: "ci-preview" }, preview),
              c.unread ? el("span", { class: "badge" }, String(c.unread)) : null),
            c.last ? el("div", { class: "ci-mode" }, modeText(c)) : null)));
      }
    }
    // Люди
    list.append(el("div", { class: "ci-section" }, tx("👥 Люди")));
    if (!rooms.length) list.append(el("p", { class: "ci-hint" }, tx("Нажми ＋ внизу → «Чат с человеком»: переписка и файлы до 10 ГБ по коду, без регистрации.")));
    for (const r of rooms) list.append(roomRow(r));
  }

  function roomRow(r) {
    return el("button", { class: "chat-item", type: "button", onclick: () => PDPeople.open(r.id) },
      el("div", { class: "avatar person" }, (r.title.trim()[0] || "?").toUpperCase(), r.online ? el("span", { class: "online" }) : null),
      el("div", { class: "ci-main" },
        el("div", { class: "ci-row" },
          el("span", { class: "ci-name" }, r.title),
          el("span", { class: "ci-time" }, r.last ? fmtTime(r.last.created) : "")),
        el("div", { class: "ci-row" },
          el("span", { class: "ci-preview" }, PDPeople.preview(r)),
          r.unread ? el("span", { class: "badge" }, String(r.unread)) : null)));
  }

  async function loadChats() {
    if (guest) {
      guest = await api(ROLE, "/api/guest/rooms");
      if (!guest.rooms.length) { guest = null; throw Object.assign(new Error(tx("нет чатов")), { status: 401 }); }
      if (!openId) renderList();
      return;
    }
    info = await api(ROLE, "/api/phone/chats");
    chats = info.chats;
    chat.maxUploadMb = info.max_upload_mb;
    if (!openId) renderList();
  }

  function reloadSoon() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadChats().catch(() => {}), 300);
  }

  function showList(replace = false) {
    const wasInside = !$("chatView").hidden || !$("toolView").hidden;
    openId = chat.chatId = null;
    $("chatView").hidden = $("toolView").hidden = true;
    $("listView").hidden = false;
    if (wasInside) animateView("listView", "back");
    if (replace) history.replaceState(null, "", "/chat");
    loadChats().catch((e) => e.status === 401 && showGate());
  }

  function setHeader(c) {
    $("pcName").textContent = c.label;
    $("pcStatus").textContent = c.pc_online ? tx("в сети") : c.mode === "remember"
      ? tx("не в сети — сообщение дождётся")
      : tx("не в сети — чат удалится через минуту");
  }

  async function openChat(id, pushHistory = true) {
    let data;
    try {
      data = await api(ROLE, `/api/chats/${id}`);
    } catch (e) {
      toast(e.message, true);
      return showList(true);
    }
    openId = chat.chatId = id;
    setHeader(data.chat);
    chat.setMessages(data.messages);
    $("listView").hidden = $("toolView").hidden = true;
    $("chatView").hidden = false;
    animateView("chatView", "forward");
    if (pushHistory) history.pushState({ c: id }, "", `/chat?c=${id}`);
    markRead();
  }

  function openTool(id, pushHistory = true) {
    if (!PDTools.open(id)) return showList(true);
    const already = !$("toolView").hidden;  // например, вернулись из редактора страницы
    openId = chat.chatId = null;
    $("listView").hidden = $("chatView").hidden = true;
    $("toolView").hidden = false;
    if (!already) animateView("toolView", "forward");
    if (pushHistory) history.pushState({ t: id }, "", `/chat?t=${id}`);
  }
  $("toolBack").addEventListener("click", () => {
    if (history.state && history.state.t) history.back();
    else showList(true);
  });

  function markRead() {
    if (openId && !document.hidden) api(ROLE, `/api/chats/${openId}/read`, { method: "POST" }).catch(() => {});
  }

  // ---------- события с сервера
  // Звонок в чате с человеком, пока открыт список чатов: «Ответить» откроет этот чат.
  PDCall.init({ role: ROLE, room: () => null });

  function onEvent(msg) {
    if (msg.type && msg.type.startsWith("call_")) return PDCall.event(msg);
    if (msg.type === "message") {
      if (msg.chat_id === openId) markRead();
      else reloadSoon();
    } else if (msg.type === "presence") {
      const c = chats.find((x) => x.id === msg.chat_id);
      if (c) {
        c.pc_online = msg.pc_online;
        if (msg.chat_id === openId) setHeader(c);
        else if (!openId) renderList();
      }
    } else if (msg.type === "chat_removed") {
      const reasons = { pc_closed: tx("Компьютер отключён — переписка удалена"),
        pc_left: tx("Вкладку на чужом компьютере закрыли — переписка удалена"),
        expired: tx("Компьютер долго не использовался и был отключён") };
      if (msg.chat_id === openId) {
        toast(reasons[msg.reason] || tx("Чат удалён"));
        showList(true);
      } else reloadSoon();
    } else if (msg.type === "renamed") {
      const c = chats.find((x) => x.id === msg.chat_id);
      if (c) c.label = msg.label;
      if (msg.chat_id === openId && c) setHeader(c);
      reloadSoon();
    } else if (msg.type === "chats_changed") {
      reloadSoon();
    } else if (msg.type === "rooms_changed") {
      PDPeople.refreshSoon();  // новое сообщение в чате с человеком
    }
  }

  document.addEventListener("visibilitychange", markRead);
  window.addEventListener("popstate", () => {
    const q = new URLSearchParams(location.search);
    if (q.get("c")) openChat(q.get("c"), false);
    else if (q.get("t")) openTool(q.get("t"), false);
    else showList();
  });

  // ---------- старт
  // После входа через Google сервер возвращает сюда с ?login=ok или ?login_error=…
  if (params.get("login_error")) toast(params.get("login_error"), true);
  else if (params.get("login") === "ok") toast(tx("Вход выполнен ✅"));
  if (params.has("login") || params.has("login_error")) history.replaceState(null, "", "/chat");

  $("menuUsers").addEventListener("click", () => PDAdmin.open());
  $("menuAccount").addEventListener("click", async () => {
    if (guest) { location.href = "/auth/google?role=phone"; return; }
    const acc = info && info.account;
    if (!acc || !acc.google) { location.href = "/auth/google?role=phone"; return; }
    if (!confirm(tx("Выйти из {0} на этом телефоне? Войти снова можно через Google.", acc.email))) return;
    try { await api(ROLE, "/api/phone/logout", { method: "POST" }); } catch (e) { return toast(e.message, true); }
    chats = [];
    showGate(tx("Ты вышел"), tx("Войди через Google, чтобы вернуться к своим чатам."));
  });

  async function start() {
    // Пришли по ссылке из QR: /pair/<код>. Код тратим POST-запросом и убираем из адреса.
    const match = location.pathname.match(/^\/pair\/([\w-]+)$/);
    let target = params.get("c");
    if (match) {
      history.replaceState(null, "", "/chat");
      try {
        const res = await api(ROLE, `/api/pair/${match[1]}`, { method: "POST" });
        target = res.chat_id;
        toast(res.relinked ? tx("Телефон переподключён — все чаты на месте") : tx("Компьютер подключён"));
      } catch (e) {
        try { await loadChats(); } catch { /* аккаунта ещё нет */ }
        if (chats.length) { toast(e.message, true); chat.connect(); return; }
        return showGate(tx("Не удалось подключиться"), e.message);
      }
    }
    if (params.get("share") === "nosession") {
      history.replaceState(null, "", "/chat");
      return showGate(tx("Некуда отправить"), tx("Сначала подключи компьютер по QR-коду, потом поделись файлом ещё раз."));
    }
    try {
      await loadChats();
    } catch (e) {
      if (e.status !== 401) {
        toast(e.message, true);
        return setTimeout(start, 5000);
      }
      // Своего аккаунта нет. Может, это собеседник, вошедший в чат по коду?
      try {
        guest = {};
        await loadChats();
      } catch {
        guest = null;
        return showGate();
      }
      return startGuest();
    }
    chat.connect();
    push.sync(ROLE, info.vapid_key);
    PDPeople.refresh();  // чаты с людьми — в том же списке
    const shared = params.get("shared");
    const toolId = params.get("t");
    if (toolId && PDTools.has(toolId)) {
      tab = "tools";
      setTab("tools");
      history.replaceState(null, "", "/chat");
      history.pushState({ t: toolId }, "", `/chat?t=${toolId}`);
      openTool(toolId, false);
    } else if (target && chats.some((c) => c.id === target)) {
      history.replaceState(null, "", "/chat");
      await openChat(target);
    }
    if (shared !== null) {
      toast(shared === "0" ? tx("Нечего было отправить") : tx("Отправлено на компьютер: {0}", shared), shared === "0");
    }
  }

  // Режим собеседника: свои чаты по коду и инструменты. Обновляем список раз в 20 секунд.
  function startGuest() {
    document.body.dataset.guest = "1";
    $("listView").querySelector(".name").textContent = "PhoneDrop";
    push.sync(ROLE, guest.vapid_key);
    setInterval(() => { if (!document.hidden && !openId && $("toolView").hidden) loadChats().catch(() => {}); }, 20000);
    const toolId = params.get("t");
    if (toolId && PDTools.has(toolId)) {
      setTab("tools");
      history.replaceState(null, "", "/chat");
      history.pushState({ t: toolId }, "", `/chat?t=${toolId}`);
      openTool(toolId, false);
    }
  }

  // ---------- меню
  function toggleMenu(id) {
    return (e) => {
      e.stopPropagation();
      for (const m of ["listMenu", "chatMenu"]) if (m !== id) $(m).hidden = true;
      $(id).hidden = !$(id).hidden;
    };
  }
  $("listMenuBtn").addEventListener("click", toggleMenu("listMenu"));
  $("chatMenuBtn").addEventListener("click", toggleMenu("chatMenu"));
  document.addEventListener("click", () => { $("listMenu").hidden = $("chatMenu").hidden = true; });

  $("backBtn").addEventListener("click", () => {
    if (history.state && history.state.c) history.back();
    else showList(true);
  });

  $("renameBtn").addEventListener("click", async () => {
    const current = chats.find((c) => c.id === openId);
    const name = prompt(tx("Как назвать этот компьютер? Например: Рабочий ноутбук"), current ? current.label : "");
    if (!name || !name.trim()) return;
    try {
      const { label } = await api(ROLE, `/api/chats/${openId}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (current) { current.label = label; setHeader(current); }
    } catch (e) {
      toast(e.message, true);
    }
  });

  $("placeBtn").addEventListener("click", () => {
    const current = chats.find((c) => c.id === openId);
    const chatId = openId;
    const close = () => backdrop.remove();
    const pick = (place) => async () => {
      close();
      try {
        await api(ROLE, `/api/chats/${chatId}/place`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ place }),
        });
        if (current) current.place = place;
        toast(tx("Готово — в списке компьютер будет в этом разделе"));
      } catch (e) {
        toast(e.message, true);
      }
    };
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => e.target === backdrop && close() },
      el("div", { class: "sheet" }, el("h3", {}, tx("Где стоит этот компьютер?")),
        ...PLACES.map(([key, title]) => el("button", { type: "button", onclick: pick(key) },
          el("span", {}, key ? title : tx("💻 Не важно")),
          current && (current.place || "") === key ? el("span", { class: "sheet-online" }, "✓") : null)),
        el("button", { type: "button", class: "cancel", onclick: close }, tx("Отмена"))));
    document.body.append(backdrop);
  });

  // «Переподключить компьютер»: на компьютере слетел вход и он показывает новый QR.
  // Сканируем его — и этот браузер получает старый чат со всей перепиской.
  $("reattachBtn").addEventListener("click", () => {
    const chatId = openId;
    toast(tx("Открой PhoneDrop на компьютере и наведи камеру на QR-код"));
    openScanner(async (code) => {
      try {
        const { label } = await api(ROLE, `/api/chats/${chatId}/reattach`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
        });
        toast(tx("«{0}» переподключён — переписка на месте", label));
        await loadChats();
        if (openId === chatId) openChat(chatId, false);
      } catch (e) {
        toast(e.message, true);
      }
    });
  });

  $("removeBtn").addEventListener("click", async () => {
    if (!confirm(tx("Отключить этот компьютер? Переписка и файлы удалятся с сервера."))) return;
    try {
      await api(ROLE, `/api/chats/${openId}`, { method: "DELETE" });
      toast(tx("Компьютер отключён"));
    } catch (e) {
      toast(e.message, true);
    }
    showList(true);
  });

  async function enablePush() {
    try {
      await push.enable(ROLE, guest ? guest.vapid_key : info.vapid_key);
      toast(tx("Уведомления включены"));
    } catch (e) {
      toast(e.message, true);
    }
    renderList();
  }
  $("pushBannerBtn").addEventListener("click", enablePush);
  function pushMenu() {
    const status = push.status();
    if (status === "granted") toast(tx("Уведомления уже включены ✅"));
    else if (status === "unsupported") toast(tx("Этот браузер не поддерживает уведомления"), true);
    else if (status === "denied") toast(tx("Уведомления запрещены. Разреши их в настройках сайта в Chrome"), true);
    else enablePush();
  }
  $("menuPush").addEventListener("click", pushMenu);
  $("chatMenuPush").addEventListener("click", pushMenu);

  // ---------- сканер QR внутри приложения
  // Распознаём QR своим кодом (jsQR лежит на нашем же сервере) — одинаково в любом браузере:
  // Chrome и Samsung Internet на Android, Safari на iPhone, значок на рабочем столе.
  let stream = null;
  let jsqrLoading = null;
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    jsqrLoading = jsqrLoading || new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/static/vendor/jsQR.min.js";
      s.onload = resolve;
      s.onerror = () => { jsqrLoading = null; reject(new Error(tx("Не загрузился сканер — проверь интернет"))); };
      document.head.append(s);
    });
    return jsqrLoading;
  }
  // onPair(код) — что делать с найденным кодом. Без него — обычное подключение нового компьютера.
  async function openScanner(onPair) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(tx("Камера недоступна в этом браузере — наведи обычную камеру телефона на QR-код"), true);
      return;
    }
    try { await loadJsQR(); } catch (e) { toast(e.message, true); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch {
      toast(tx("Нет доступа к камере. Разреши его в настройках браузера"), true);
      return;
    }
    const video = $("cam");
    video.srcObject = stream;
    await video.play();
    $("scanner").hidden = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const decode = window.jsQR && (window.jsQR.default || window.jsQR);

    function read() {
      if (video.readyState < 2 || !video.videoWidth) return [];
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));  // меньше — быстрее
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = decode(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      return found ? [found.data] : [];
    }

    const tick = async () => {
      if (!stream) return;
      try {
        for (const value of read()) {
          const url = new URL(value, location.href);
          // Принимаем только коды нашего же сайта.
          if (url.origin === location.origin && url.pathname.startsWith("/pair/")) {
            closeScanner();
            if (typeof onPair === "function") onPair(url.pathname.slice("/pair/".length));
            else location.href = url.href;
            return;
          }
        }
      } catch { /* кадр не распознан */ }
      setTimeout(tick, 120);  // ~8 кадров в секунду: быстро находит код и не греет телефон
    };
    tick();
  }
  function closeScanner() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    $("scanner").hidden = true;
  }
  $("gateScan").addEventListener("click", () => openScanner());

  // ＋ внизу списка: подключить свой компьютер или начать чат с человеком.
  $("fabAdd").addEventListener("click", () => {
    if (guest) { location.href = "/get"; return; }  // собеседник: войти ещё в один чат по коду
    const close = () => backdrop.remove();
    const item = (text, sub, fn) => el("button", { type: "button", onclick: () => { close(); fn(); } },
      el("span", { class: "add-item" }, el("b", {}, text), el("small", {}, sub)));
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => e.target === backdrop && close() },
      el("div", { class: "sheet" },
        el("h3", {}, tx("Новый чат")),
        item(tx("💻 Мой компьютер"), tx("Открой PhoneDrop на компьютере и отсканируй QR-код"), () => openScanner()),
        item(tx("👤 Чат с человеком"), tx("Получишь код — собеседник введёт его на сайте"), () => PDPeople.askNewChat()),
        el("button", { type: "button", class: "cancel", onclick: close }, tx("Отмена"))));
    document.body.append(backdrop);
  });
  $("scanClose").addEventListener("click", closeScanner);

  // ---------- установка как приложение (PWA)
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    $("installBtn").hidden = false;
    $("gateInstall").hidden = $("gate").hidden;
  });
  async function install() {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    $("installBtn").hidden = $("gateInstall").hidden = true;
  }
  $("installBtn").addEventListener("click", install);
  $("gateInstall").addEventListener("click", install);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  start();
})();
