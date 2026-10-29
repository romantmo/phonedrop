// PhoneDrop — компьютер: QR-код, режим «чужой/мой», уведомления, чат с телефоном.
"use strict";

(() => {
  let peopleChecked = false;
  const { $, api, toast, Chat, push } = PD;
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
    $("tabs").hidden = !linked;  // инструменты — только для подключённого к телефону компьютера
    if (linked && !peopleChecked) { peopleChecked = true; PDPeople.refresh(); }  // точка на «Люди»
    if (!linked) showSection("chat");
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
      if (state.linked) { push.sync(ROLE, state.vapid_key); PDTransfers.refresh(); }
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
      PDTransfers.refresh();
    } else if (msg.type === "shares_changed") {
      PDShares.refresh();
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

  // ---------- вкладки «Чат | Инструменты»
  let section = "chat";
  function showSection(name) {
    section = name;
    $("dropZone").hidden = name !== "chat";
    $("toolsMain").hidden = name !== "tools";
    $("transfersMain").hidden = name !== "transfers";
    $("peopleMain").hidden = name !== "people";
    if (name === "people") PDPeople.mount($("peopleHome"));
    if (name === "transfers") { $("trDot").hidden = true; PDTransfers.refresh(); }
    for (const [id, value] of [["tabChat", "chat"], ["tabTools", "tools"], ["tabPeople", "people"], ["tabTransfers", "transfers"]]) {
      $(id).classList.toggle("on", section === value);
      $(id).setAttribute("aria-selected", String(section === value));
    }
    if (name === "tools" && $("toolView").hidden) showToolsHome();
  }
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
  $("tabTransfers").addEventListener("click", () => showSection("transfers"));
  $("tabPeople").addEventListener("click", () => showSection("people"));
  PDPeople.onUnread((n) => { $("peDot").hidden = !n; });
  function transferMode(share) {
    $("trModeMine").classList.toggle("on", !share);
    $("trModeShare").classList.toggle("on", share);
    $("mineBody").hidden = share;
    $("shareBody").hidden = !share;
    if (share) PDShares.mount($("shareBody"));
  }
  $("trModeMine").addEventListener("click", () => transferMode(false));
  $("trModeShare").addEventListener("click", () => transferMode(true));
  PDTransfers.onIncoming((t) => {
    toast(`📦 Пришёл файл «${t.name}» с «${t.from_label}»`);
    if (section !== "transfers") $("trDot").hidden = false;
  });
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
