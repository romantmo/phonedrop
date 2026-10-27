// PhoneDrop — компьютер: QR-код, режим «чужой/мой», уведомления, чат с телефоном.
"use strict";

(() => {
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
    $("deviceName").textContent = state.device.label;
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
      render();
      chat.connect();
      if (state.linked) push.sync(ROLE, state.vapid_key);
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
    } else if (msg.type === "presence") {
      state.phone_online = msg.phone_online;
      render();
    }
  }

  function onClosed(reason) {
    chat.stop();
    clearInterval(pairTimer);
    const texts = {
      phone_removed: "Телефон отключил этот компьютер — переписка удалена",
      expired: "Компьютер долго не использовался и был отключён",
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

  $("pushBtn").addEventListener("click", async () => {
    try {
      await push.enable(ROLE, state.vapid_key);
      toast("Уведомления включены");
    } catch (e) {
      toast(e.message, true);
    }
    renderPush();
  });

  $("logoutBtn").addEventListener("click", async () => {
    if (!confirm("Отключить этот компьютер? Переписка с телефоном и файлы удалятся с сервера.")) return;
    chat.stop();
    try { await api(ROLE, "/api/pc/logout", { method: "POST" }); } catch { /* уже отключён */ }
    toast("Компьютер отключён, всё удалено");
    start();
  });

  start();
})();
