// PhoneDrop — телефон: список компьютеров, чаты, подключение по QR, уведомления.
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
  let tab = "chats"; // вкладка на главном экране: «Компьютеры» или «Инструменты»

  const chat = new Chat({
    role: ROLE,
    enterSends: false, // на телефоне Enter — новая строка, отправка кнопкой
    onEvent,
    onClosed: (reason) => reason === "relinked"
      ? showGate("Чаты открыты на другом телефоне",
        "Если это был не ты — на своём компьютере нажми «📱 Переподключить телефон» и отсканируй код этим телефоном.")
      : showGate(),
    onResync: async () => { await loadChats(); if (openId) openChat(openId, false); },
    onConnection: (ok) => { if (!ok && openId) $("pcStatus").textContent = "нет связи с сервером…"; },
  });

  // ---------- экраны
  function showGate(title, text) {
    chat.stop();
    openId = chat.chatId = null;
    $("chatView").hidden = $("toolView").hidden = true;
    $("listView").hidden = false;
    $("chatList").hidden = $("fabScan").hidden = $("pushBanner").hidden = true;
    $("tabs").hidden = $("toolsHome").hidden = true;
    $("gate").hidden = false;
    $("gateTitle").textContent = title || "Подключи компьютер";
    $("gateText").textContent = text || "Открой PhoneDrop на компьютере и отсканируй QR-код.";
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
    return c.mode === "remember" ? "🏠 мой компьютер" : "🏢 чужой — удалится после закрытия";
  }

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

  function renderList() {
    $("gate").hidden = true;
    $("tabs").hidden = false;
    const tools = tab === "tools";
    $("toolsHome").hidden = !tools;
    $("chatList").hidden = $("fabScan").hidden = tools;
    $("pushBanner").hidden = tools || !(chats.length && push.status() === "default");
    if (tools) {
      PDTools.renderHome($("toolsHome"), (id) => openTool(id));
      return;
    }
    const list = $("chatList");
    list.replaceChildren();
    if (!chats.length) {
      list.append(el("div", { class: "empty list-empty" },
        el("div", { class: "big" }, "🖥️"), el("b", {}, "Нет подключённых компьютеров"),
        "Открой PhoneDrop на компьютере и нажми кнопку QR внизу."));
      return;
    }
    for (const c of chats) {
      const preview = c.last ? (c.last.sender === "phone" ? "Вы: " : "") + c.last.preview : modeText(c);
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

  async function loadChats() {
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
    $("pcStatus").textContent = c.pc_online ? "в сети" : c.mode === "remember"
      ? "не в сети — сообщение дождётся"
      : "не в сети — чат удалится через минуту";
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
  function onEvent(msg) {
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
      const reasons = { pc_closed: "Компьютер отключён — переписка удалена",
        pc_left: "Вкладку на чужом компьютере закрыли — переписка удалена",
        expired: "Компьютер долго не использовался и был отключён" };
      if (msg.chat_id === openId) {
        toast(reasons[msg.reason] || "Чат удалён");
        showList(true);
      } else reloadSoon();
    } else if (msg.type === "renamed") {
      const c = chats.find((x) => x.id === msg.chat_id);
      if (c) c.label = msg.label;
      if (msg.chat_id === openId && c) setHeader(c);
      reloadSoon();
    } else if (msg.type === "chats_changed") {
      reloadSoon();
    } else if (msg.type === "shares_changed") {
      PDShares.refresh();  // кто-то скачал файл из посылки
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
  async function start() {
    // Пришли по ссылке из QR: /pair/<код>. Код тратим POST-запросом и убираем из адреса.
    const match = location.pathname.match(/^\/pair\/([\w-]+)$/);
    let target = params.get("c");
    if (match) {
      history.replaceState(null, "", "/chat");
      try {
        const res = await api(ROLE, `/api/pair/${match[1]}`, { method: "POST" });
        target = res.chat_id;
        toast(res.relinked ? "Телефон переподключён — все чаты на месте" : "Компьютер подключён");
      } catch (e) {
        try { await loadChats(); } catch { /* аккаунта ещё нет */ }
        if (chats.length) { toast(e.message, true); chat.connect(); return; }
        return showGate("Не удалось подключиться", e.message);
      }
    }
    if (params.get("share") === "nosession") {
      history.replaceState(null, "", "/chat");
      return showGate("Некуда отправить", "Сначала подключи компьютер по QR-коду, потом поделись файлом ещё раз.");
    }
    try {
      await loadChats();
    } catch (e) {
      if (e.status === 401) return showGate();
      toast(e.message, true);
      return setTimeout(start, 5000);
    }
    chat.connect();
    push.sync(ROLE, info.vapid_key);
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
      toast(shared === "0" ? "Нечего было отправить" : `Отправлено на компьютер: ${shared}`, shared === "0");
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
    const name = prompt("Как назвать этот компьютер? Например: Рабочий ноутбук", current ? current.label : "");
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

  // «Переподключить компьютер»: на компьютере слетел вход и он показывает новый QR.
  // Сканируем его — и этот браузер получает старый чат со всей перепиской.
  $("reattachBtn").addEventListener("click", () => {
    const chatId = openId;
    toast("Открой PhoneDrop на компьютере и наведи камеру на QR-код");
    openScanner(async (code) => {
      try {
        const { label } = await api(ROLE, `/api/chats/${chatId}/reattach`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
        });
        toast(`«${label}» переподключён — переписка на месте`);
        await loadChats();
        if (openId === chatId) openChat(chatId, false);
      } catch (e) {
        toast(e.message, true);
      }
    });
  });

  $("removeBtn").addEventListener("click", async () => {
    if (!confirm("Отключить этот компьютер? Переписка и файлы удалятся с сервера.")) return;
    try {
      await api(ROLE, `/api/chats/${openId}`, { method: "DELETE" });
      toast("Компьютер отключён");
    } catch (e) {
      toast(e.message, true);
    }
    showList(true);
  });

  async function enablePush() {
    try {
      await push.enable(ROLE, info.vapid_key);
      toast("Уведомления включены");
    } catch (e) {
      toast(e.message, true);
    }
    renderList();
  }
  $("pushBannerBtn").addEventListener("click", enablePush);
  function pushMenu() {
    const status = push.status();
    if (status === "granted") toast("Уведомления уже включены ✅");
    else if (status === "unsupported") toast("Этот браузер не поддерживает уведомления", true);
    else if (status === "denied") toast("Уведомления запрещены. Разреши их в настройках сайта в Chrome", true);
    else enablePush();
  }
  $("menuPush").addEventListener("click", pushMenu);
  $("chatMenuPush").addEventListener("click", pushMenu);

  // ---------- сканер QR внутри приложения (Chrome на Android)
  let stream = null;
  // onPair(код) — что делать с найденным кодом. Без него — обычное подключение нового компьютера.
  async function openScanner(onPair) {
    if (!("BarcodeDetector" in window)) {
      toast(typeof onPair === "function"
        ? "В этом браузере нет сканера QR — открой PhoneDrop в Chrome"
        : "Сканер недоступен в этом браузере — наведи обычную камеру телефона на QR-код", true);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch {
      toast("Нет доступа к камере", true);
      return;
    }
    const video = $("cam");
    video.srcObject = stream;
    await video.play();
    $("scanner").hidden = false;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const tick = async () => {
      if (!stream) return;
      try {
        for (const code of await detector.detect(video)) {
          const url = new URL(code.rawValue, location.href);
          // Принимаем только коды нашего же сайта.
          if (url.origin === location.origin && url.pathname.startsWith("/pair/")) {
            closeScanner();
            if (typeof onPair === "function") onPair(url.pathname.slice("/pair/".length));
            else location.href = url.href;
            return;
          }
        }
      } catch { /* кадр не распознан */ }
      requestAnimationFrame(tick);
    };
    tick();
  }
  function closeScanner() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    $("scanner").hidden = true;
  }
  for (const id of ["gateScan", "menuScan", "fabScan"]) $(id).addEventListener("click", () => openScanner());
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
