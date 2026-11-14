// Звонки в чатах с людьми: аудио и видео (WebRTC).
//
// Как это работает (для чайника):
// 1. Звонящий включает микрофон (и камеру), браузер готовит «предложение» (offer) — описание,
//    как с ним соединиться. Мы отправляем его на сервер, сервер будит собеседника (WebSocket + push).
// 2. Собеседник нажимает «Ответить», его браузер готовит «ответ» (answer) — и всё: дальше звук
//    и видео идут НАПРЯМУЮ между браузерами, зашифрованные (DTLS-SRTP). Сервер разговор не видит.
// 3. Если напрямую не выходит (мобильный интернет, строгие роутеры) — помогает наш TURN-сервер:
//    он просто пересылает зашифрованные пакеты, расшифровать их не может.
// Описание соединения отправляем целиком, когда браузер нашёл все пути (без «trickle ICE») —
// так проще: одно сообщение туда, одно обратно.
window.PDCall = (() => {
  const { $, el, toast, api } = PD;
  const SUPPORTED = !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const MOBILE = matchMedia("(pointer: coarse)").matches;
  const CAN_SHARE = !MOBILE && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  const ICON = {
    call: "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z",
    end: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
    mic: "M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
    micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
    cam: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
    camOff: "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2 2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
    flip: "M20 5h-3.17L15 3H9L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-5 11.5V14H9v2.5L5.5 13 9 9.5V12h6V9.5l3.5 3.5-3.5 3.5z",
    screen: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
  };
  const svg = (d) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", d);
    s.append(p);
    return s;
  };

  let opts = { role: "room", room: () => null };
  let cur = null;        // текущий звонок: { id, call, pc, local, remote, ... }
  let ui = null;         // экран звонка
  const seen = new Set(); // звонки, которые уже показывали (сообщение могло прийти дважды)

  // ------------------------------------------------ звуки: гудки и мелодия входящего
  const tones = (() => {
    let ctx = null;
    let timer = null;
    const unlock = () => {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume();
      } catch { /* без звука */ }
    };
    for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, unlock, { capture: true, passive: true });
    function beep(freq, start, len, vol = 0.08) {
      if (!ctx || ctx.state !== "running") return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = ctx.currentTime + start;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.setValueAtTime(vol, t + len - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + len + 0.05);
    }
    return {
      unlock,
      stop() { clearInterval(timer); timer = null; if (navigator.vibrate) try { navigator.vibrate(0); } catch { /* нет */ } },
      // Входящий: короткая мелодия раз в 2,5 секунды + вибрация.
      ring() {
        this.stop();
        const play = () => {
          [[659, 0], [784, 0.18], [988, 0.36], [784, 0.54]].forEach(([f, s]) => beep(f, s, 0.16, 0.1));
          if (navigator.vibrate) try { navigator.vibrate([400, 200, 400]); } catch { /* нет */ }
        };
        play();
        timer = setInterval(play, 2500);
      },
      // Исходящий: длинный гудок раз в 4 секунды, как в телефоне.
      back() {
        this.stop();
        const play = () => beep(425, 0, 1, 0.05);
        play();
        timer = setInterval(play, 4000);
      },
      end() { this.stop(); beep(480, 0, 0.15, 0.06); beep(380, 0.2, 0.25, 0.06); },
    };
  })();

  // ------------------------------------------------ экран звонка
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function button(cls, icon, label, onclick) {
    const b = el("button", { type: "button", class: "call-btn " + cls, "aria-label": label, title: label, onclick }, svg(icon));
    b.setIcon = (d) => b.replaceChildren(svg(d));
    return b;
  }

  function buildUi(call) {
    close(true);
    const initial = (call.name || "?").trim().charAt(0).toUpperCase();
    const node = el("div", { class: "call-ov", role: "dialog", "aria-label": call.video ? tx("Видеозвонок") : tx("Аудиозвонок") });
    // Видео собеседника — в <video> без звука, звук — в отдельном <audio>: так надёжнее на iPhone.
    const remote = el("video", { class: "call-remote", playsinline: true, autoplay: true, muted: true });
    remote.muted = true;
    const audio = el("audio", { autoplay: true });
    const local = el("video", { class: "call-local", playsinline: true, autoplay: true, muted: true, hidden: true });
    local.muted = true;
    const status = el("div", { class: "call-status" });
    const info = el("div", { class: "call-info" },
      el("div", { class: "call-avatar" }, initial),
      el("div", { class: "call-name", dir: "auto" }, call.name || ""),
      status);
    const actions = el("div", { class: "call-actions" });
    const sound = el("button", { type: "button", class: "call-unmute", hidden: true, onclick: () => {
      audio.play().then(() => (sound.hidden = true)).catch(() => {});
      if (remote.srcObject) remote.play().catch(() => {});
    } }, tx("🔊 Нажми, чтобы слышать собеседника"));
    node.append(remote, audio, local, info, sound, actions);
    document.body.append(node);
    document.body.classList.add("in-call");
    ui = { node, remote, audio, local, status, actions, info, sound };
    return ui;
  }

  function setStatus(text) { if (ui) ui.status.textContent = text; }

  function showIncoming(call) {
    const u = buildUi(call);
    u.node.dataset.state = "incoming";
    setStatus(call.video ? tx("🎥 Входящий видеозвонок") : tx("📞 Входящий звонок"));
    u.actions.append(
      button("red", ICON.end, tx("Отклонить"), () => decline(call)),
      button("green", call.video ? ICON.cam : ICON.call, tx("Ответить"), () => accept(call)),
    );
    tones.ring();
  }

  function showActive() {
    if (!ui || !cur) return;
    ui.node.dataset.state = "active";
    ui.actions.replaceChildren();
    const mic = button("", ICON.mic, tx("Микрофон"), () => {
      const track = cur.local.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      mic.classList.toggle("off", !track.enabled);
      mic.setIcon(track.enabled ? ICON.mic : ICON.micOff);
    });
    const cam = button("", ICON.cam, tx("Камера"), () => toggleCamera().then(paint));
    const flip = MOBILE ? button("", ICON.flip, tx("Сменить камеру"), () => flipCamera()) : null;
    const screen = CAN_SHARE ? button("", ICON.screen, tx("Показать экран"), () => toggleScreen().then(paint)) : null;
    const hang = button("red", ICON.end, tx("Завершить"), () => hangup());
    function paint() {
      const on = !!cur && !!cur.videoTrack;
      cam.classList.toggle("off", !on || !!cur.screen);
      cam.setIcon(on && !cur.screen ? ICON.cam : ICON.camOff);
      if (flip) flip.hidden = !on;
      if (screen) screen.classList.toggle("on", !!(cur && cur.screen));
      ui.local.hidden = !on;
    }
    ui.actions.append(mic, cam, ...(flip ? [flip] : []), ...(screen ? [screen] : []), hang);
    paint();
  }

  function close(silent) {
    tones.stop();
    if (ui) {
      ui.node.remove();
      ui = null;
    }
    document.body.classList.remove("in-call");
    if (!silent) tones.end();
  }

  // ------------------------------------------------ соединение
  async function iceServers() {
    try {
      return (await api(opts.role, "/api/calls/ice")).ice_servers || [];
    } catch {
      return [];
    }
  }

  async function media(video) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio, video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (e) {
      if (video) {  // камеры нет или запрещена — звоним хотя бы голосом
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio });
          toast(tx("Камера недоступна — звонок будет без видео"), true);
          return s;
        } catch { /* ниже */ }
      }
      throw new Error(e && e.name === "NotAllowedError"
        ? tx("Нет доступа к микрофону. Разреши его в настройках браузера")
        : tx("Не получилось включить микрофон"));
    }
  }

  // Ждём, пока браузер найдёт все пути соединения (обычно меньше секунды, максимум 3 с).
  function gathered(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(resolve, 3000);
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") done(); });
    });
  }

  function newPeer(servers, call) {
    const pc = new RTCPeerConnection({ iceServers: servers });
    cur.remote = new MediaStream();
    pc.ontrack = (e) => {
      cur.remote.addTrack(e.track);
      e.track.addEventListener("unmute", attachRemote);
      attachRemote();
    };
    pc.onconnectionstatechange = () => {
      if (!cur || cur.pc !== pc) return;
      const s = pc.connectionState;
      console.debug("PhoneDrop call:", s);
      if (s === "connected") {
        if (!cur.since) {
          cur.since = Date.now();
          tones.stop();
          cur.clock = setInterval(() => setStatus(fmt((Date.now() - cur.since) / 1000)), 1000);
          setStatus("0:00");
          wakeLock();
        } else {
          setStatus(fmt((Date.now() - cur.since) / 1000));
        }
      } else if (s === "disconnected") {
        setStatus(tx("Связь прервалась, восстанавливаю…"));
      } else if (s === "failed") {
        finish("failed", true);
      }
    };
    return pc;
  }

  // Подключить звук и видео собеседника к экрану. Safari не всегда замечает дорожки,
  // добавленные в уже показанный поток, поэтому каждый раз отдаём элементам новый поток.
  function attachRemote() {
    if (!ui || !cur || !cur.remote) return;
    const audioTracks = cur.remote.getAudioTracks();
    const videoTracks = cur.remote.getVideoTracks();
    if (audioTracks.length) {
      ui.audio.srcObject = new MediaStream(audioTracks);
      ui.audio.play().then(() => { if (ui) ui.sound.hidden = true; }).catch(() => { if (ui) ui.sound.hidden = false; });
    }
    if (videoTracks.length) {
      ui.remote.srcObject = new MediaStream(videoTracks);
      ui.remote.play().catch(() => { /* видео без звука играет само */ });
    }
  }

  // Служебный канал: сообщаем собеседнику, включена ли у нас камера или показ экрана.
  function wireControl(channel) {
    cur.ctl = channel;
    channel.onmessage = (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { return; }
      if (ui && data && typeof data.video === "boolean") ui.node.classList.toggle("peer-video", data.video);
    };
    channel.onopen = () => sendControl();
  }

  function sendControl() {
    if (cur && cur.ctl && cur.ctl.readyState === "open") {
      cur.ctl.send(JSON.stringify({ video: !!cur.videoTrack || !!cur.screen }));
    }
  }

  function videoSender() {
    return cur.pc.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === "video")?.sender;
  }

  function showLocal() {
    if (!ui) return;
    const tracks = [cur.screen || cur.videoTrack].filter(Boolean);
    ui.local.srcObject = tracks.length ? new MediaStream(tracks) : null;
    ui.local.hidden = !tracks.length;
    ui.local.classList.toggle("mirror", !cur.screen && cur.facing !== "environment");
  }

  async function toggleCamera() {
    if (!cur) return;
    const sender = videoSender();
    if (cur.videoTrack) {
      cur.videoTrack.stop();
      cur.videoTrack = null;
      if (!cur.screen) await sender.replaceTrack(null);
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cur.facing || "user" } });
        cur.videoTrack = s.getVideoTracks()[0];
        if (!cur.screen) await sender.replaceTrack(cur.videoTrack);
      } catch {
        return toast(tx("Нет доступа к камере. Разреши его в настройках браузера"), true);
      }
    }
    showLocal();
    sendControl();
  }

  async function flipCamera() {
    if (!cur || !cur.videoTrack) return;
    cur.facing = cur.facing === "environment" ? "user" : "environment";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: cur.facing } } });
      cur.videoTrack.stop();
      cur.videoTrack = s.getVideoTracks()[0];
      if (!cur.screen) await videoSender().replaceTrack(cur.videoTrack);
      showLocal();
    } catch {
      cur.facing = cur.facing === "environment" ? "user" : "environment";
      toast(tx("Вторая камера недоступна"), true);
    }
  }

  // Показ экрана (с компьютера): подменяем видео камеры картинкой экрана — без переподключения.
  async function toggleScreen() {
    if (!cur) return;
    const sender = videoSender();
    if (cur.screen) {
      cur.screen.stop();
      cur.screen = null;
      await sender.replaceTrack(cur.videoTrack || null);
    } else {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        cur.screen = s.getVideoTracks()[0];
        cur.screen.onended = () => { if (cur && cur.screen) toggleScreen().then(() => showActive()); };
        await sender.replaceTrack(cur.screen);
      } catch {
        return;  // человек передумал в окне выбора экрана
      }
    }
    showLocal();
    sendControl();
  }

  async function wakeLock() {
    try { if (cur && navigator.wakeLock) cur.lock = await navigator.wakeLock.request("screen"); } catch { /* не важно */ }
  }

  // ------------------------------------------------ звоним сами
  async function start(video) {
    const room = opts.room();
    if (!room || cur) return;
    if (!SUPPORTED) return toast(tx("Этот браузер не умеет звонить. Обнови его или открой в Chrome / Safari"), true);
    if (!room.joined) return toast(tx("Собеседник ещё не вошёл в чат — сначала отправь ему код"), true);
    tones.unlock();
    cur = { id: null, video, facing: "user" };
    buildUi({ name: room.name, video });
    ui.node.dataset.state = "calling";
    ui.actions.append(button("red", ICON.end, tx("Завершить"), () => hangup()));
    setStatus(tx("Включаю микрофон…"));
    try {
      const [servers, local] = await Promise.all([iceServers(), media(video)]);
      if (!cur) { local.getTracks().forEach((t) => t.stop()); return; }
      cur.local = local;
      cur.videoTrack = local.getVideoTracks()[0] || null;
      cur.pc = newPeer(servers);
      // Всегда договариваемся и о звуке, и о видео: тогда камеру или экран можно включить
      // посреди аудиозвонка без переподключения.
      cur.pc.addTransceiver(local.getAudioTracks()[0], { direction: "sendrecv", streams: [local] });
      cur.pc.addTransceiver(cur.videoTrack || "video", { direction: "sendrecv", streams: [local] });
      wireControl(cur.pc.createDataChannel("ctl"));
      showLocal();
      showActive();
      ui.node.dataset.state = "calling";
      setStatus(tx("Соединяю…"));
      await cur.pc.setLocalDescription(await cur.pc.createOffer());
      await gathered(cur.pc);
      if (!cur) return;
      const res = await api(opts.role, "/api/calls", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: room.id, video, sdp: cur.pc.localDescription.sdp }),
      });
      if (!cur) return api(opts.role, `/api/calls/${res.call.id}/end`, jsonBody({ reason: "cancel" })).catch(() => {});
      cur.id = res.call.id;
      seen.add(cur.id);
      setStatus(tx("Вызов…"));
      tones.back();
    } catch (e) {
      cleanup();
      close(false);
      toast(e.message, true);
    }
  }

  const jsonBody = (obj) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

  // ------------------------------------------------ нам звонят
  function incoming(call) {
    if (seen.has(call.id)) return;
    seen.add(call.id);
    if (cur) {  // уже разговариваем — второй звонок отклоняем как «занято»
      api(opts.role, `/api/calls/${call.id}/end`, jsonBody({ reason: "busy" })).catch(() => {});
      return;
    }
    cur = { id: call.id, call, incoming: true };
    showIncoming(call);
  }

  async function accept(call) {
    tones.stop();
    tones.unlock();
    const room = opts.room();
    // Ответить можно только со страницы этого чата: переходим туда, там звонок примется сам.
    if (!room || room.id !== call.chat_id) {
      cur = null;
      location.href = `${call.url}#call=${call.id}`;
      return;
    }
    cur = { id: call.id, call, incoming: true, video: call.video, facing: "user" };
    ui.node.dataset.state = "calling";
    ui.actions.replaceChildren(button("red", ICON.end, tx("Завершить"), () => hangup()));
    setStatus(tx("Соединяю…"));
    try {
      const [data, servers, local] = await Promise.all([
        api(opts.role, `/api/calls/${call.id}`), iceServers(), media(call.video)]);
      if (!cur || cur.id !== call.id) { local.getTracks().forEach((t) => t.stop()); return; }
      if (!data.sdp) throw new Error(tx("Звонок уже закончился"));
      cur.local = local;
      cur.videoTrack = local.getVideoTracks()[0] || null;
      cur.pc = newPeer(servers);
      cur.pc.ondatachannel = (e) => wireControl(e.channel);
      await cur.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      for (const t of cur.pc.getTransceivers()) {
        const kind = t.receiver.track && t.receiver.track.kind;
        t.direction = "sendrecv";
        await t.sender.replaceTrack(kind === "audio" ? local.getAudioTracks()[0] : cur.videoTrack);
      }
      showLocal();
      showActive();
      await cur.pc.setLocalDescription(await cur.pc.createAnswer());
      await gathered(cur.pc);
      if (!cur) return;
      await api(opts.role, `/api/calls/${call.id}/answer`, jsonBody({ sdp: cur.pc.localDescription.sdp }));
    } catch (e) {
      console.warn("PhoneDrop call: answer failed", e);
      api(opts.role, `/api/calls/${call.id}/end`, jsonBody({ reason: "failed" })).catch(() => {});
      cleanup();
      close(false);
      toast(e.message, true);
    }
  }

  function decline(call) {
    api(opts.role, `/api/calls/${call.id}/end`, jsonBody({ reason: "decline" })).catch(() => {});
    cleanup();
    close(false);
  }

  function hangup() {
    if (cur && cur.id) api(opts.role, `/api/calls/${cur.id}/end`, jsonBody({ reason: "hangup" })).catch(() => {});
    finish(null, false);
  }

  function cleanup() {
    if (!cur) return;
    clearInterval(cur.clock);
    for (const t of [...(cur.local ? cur.local.getTracks() : []), cur.videoTrack, cur.screen]) if (t) t.stop();
    try { if (cur.pc) cur.pc.close(); } catch { /* уже закрыт */ }
    try { if (cur.lock) cur.lock.release(); } catch { /* не важно */ }
    cur = null;
  }

  const END_TEXT = {
    missed: () => tx("Собеседник не ответил"),
    decline: () => tx("Собеседник отклонил звонок"),
    busy: () => tx("Собеседник сейчас разговаривает"),
    cancel: () => tx("Звонок отменён"),
    failed: () => tx("Не удалось соединиться — проверь интернет и попробуй ещё раз"),
  };

  function finish(reason, notify) {
    const since = cur && cur.since;
    const wasIncomingRinging = cur && cur.incoming && !cur.pc;
    cleanup();
    close(false);
    if (reason === "taken") return toast(tx("Ответили на другом устройстве"));
    if (wasIncomingRinging && (reason === "cancel" || reason === "missed")) return toast(tx("📞 Пропущенный звонок"));
    if (notify && END_TEXT[reason]) return toast(END_TEXT[reason](), reason === "failed");
    if (since) toast(tx("Звонок завершён · {0}", fmt((Date.now() - since) / 1000)));
  }

  // ------------------------------------------------ события с сервера
  async function event(msg) {
    if (msg.type === "call_ring") return incoming(msg.call);
    if (!cur || cur.id !== msg.id) return;
    if (msg.type === "call_answer" && cur.pc && !cur.incoming) {
      setStatus(tx("Соединяю…"));
      tones.stop();
      try {
        await cur.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } catch {
        hangup();
      }
    } else if (msg.type === "call_taken" && cur.incoming && !cur.pc) {
      finish("taken", true);
    } else if (msg.type === "call_end") {
      finish(msg.reason, true);
    }
  }

  // Страница открылась по уведомлению «Входящий звонок» или после «Ответить» в списке чатов.
  async function checkPending() {
    if (!SUPPORTED) return;
    const m = location.hash.match(/^#call=([0-9a-f]{32})$/);
    if (m) history.replaceState(null, "", location.pathname + location.search);
    let calls = [];
    try { calls = (await api(opts.role, "/api/calls/pending")).calls; } catch { return; }
    const room = opts.room();
    for (const call of calls) {
      if (m && call.id === m[1] && room && room.id === call.chat_id) {
        seen.add(call.id);
        cur = { id: call.id, call, incoming: true };
        showIncoming(call);
        accept(call);
        return;
      }
      incoming(call);
    }
  }

  // Закрыли вкладку посреди разговора — завершаем звонок, чтобы у собеседника не «висело».
  addEventListener("pagehide", () => {
    if (cur && cur.id) {
      fetch(`/api/calls/${cur.id}/end`, { method: "POST", keepalive: true, credentials: "same-origin",
        headers: { "X-PD-Role": opts.role, "Content-Type": "application/json" }, body: JSON.stringify({ reason: "hangup" }) });
    }
  });

  return {
    supported: SUPPORTED,
    init(o) { opts = Object.assign(opts, o); },
    start,
    event,
    checkPending,
    busy: () => !!cur,
    drop: () => { if (cur) finish(null, false); },
  };
})();
