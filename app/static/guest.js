// PhoneDrop — страница получателя: код или ссылка → (пароль) → список файлов.
// Регистрация не нужна. Пока посылка открыта, отправитель может докладывать файлы —
// страница проверяет новые файлы каждые 5 секунд.
"use strict";

(() => {
  const { $, el, toast, fmtSize } = PD;
  let ref = (location.pathname.match(/^\/g\/([\w.-]+)$/) || [])[1] || null;
  let timer = null;

  function show(id) {
    for (const card of ["codeCard", "pwCard", "filesCard", "uploadCard", "errorCard"]) $(card).hidden = card !== id;
  }

  async function call(path, options = {}) {
    const response = await fetch(path, Object.assign({ credentials: "same-origin" }, options));
    let data = null;
    try { data = await response.json(); } catch { /* пусто */ }
    return { status: response.status, data };
  }

  function left(expires) {
    const min = Math.max(0, (expires * 1000 - Date.now()) / 60000);
    return min >= 60 ? `${Math.floor(min / 60)} ч ${Math.round(min % 60)} мин` : `${Math.max(1, Math.round(min))} мин`;
  }

  async function load() {
    const { status, data } = await call(`/api/g/${ref}`);
    if (status === 401 && data && data.password) {
      clearInterval(timer);
      $("pwText").textContent = `«${data.owner_label}» защитил файлы паролем. Спроси его — обычно пароль говорят голосом.`;
      show("pwCard");
      $("pwInput").focus();
      return;
    }
    if (status !== 200) {
      clearInterval(timer);
      $("errorText").textContent = (data && data.detail) || "Ссылка не работает.";
      show("errorCard");
      return;
    }
    if (data.kind === "request") return showUpload(data);
    $("filesTitle").textContent = `Файлы от «${data.owner_label}»`;
    $("filesMeta").textContent = `Доступны ещё ${left(data.expires)}`;
    const rows = data.files.map((f) => el("div", { class: "g-file" },
      el("span", { class: "g-ext" }, (f.name.includes(".") ? f.name.split(".").pop() : "file").slice(0, 4)),
      el("div", { class: "g-info" }, el("b", {}, f.name), el("small", {}, fmtSize(f.size))),
      el("a", { class: "btn primary", href: f.url, download: f.name }, "⬇ Скачать")));
    for (const u of data.uploading) {
      rows.push(el("div", { class: "g-file waiting" },
        el("span", { class: "g-ext" }, "⏳"),
        el("div", { class: "g-info" }, el("b", {}, u.name),
          el("small", {}, `ещё загружается у отправителя: ${Math.floor((u.received / u.size) * 100)}% из ${fmtSize(u.size)}`))));
    }
    if (!rows.length) rows.push(el("p", { class: "g-empty" }, "Пока пусто — отправитель ещё добавляет файлы. Страница обновится сама."));
    $("filesList").replaceChildren(...rows);
    $("filesNote").textContent = data.once
      ? "🔥 Каждый файл удалится сразу после скачивания — сохрани его у себя."
      : "Если скачивание прервётся — нажми «Скачать» ещё раз, браузер продолжит с того же места.";
    show("filesCard");
  }

  // ---------- «Отправь файлы для …»: человек загружает файлы владельцу
  const uploads = [];   // { name, size, job, done, error }
  let upInfo = null;
  function upMeta() {
    $("upMeta").textContent = `Можно прислать ещё ${fmtSize(upInfo.left_bytes)} · ссылка работает ещё ${left(upInfo.expires)}`;
  }
  function showUpload(data) {
    clearInterval(timer);  // гость видит только свои загрузки — обновлять нечего
    upInfo = data;
    $("upTitle").textContent = `📤 Отправь файлы для «${data.owner_label}»`;
    upMeta();
    renderUploads();
    show("uploadCard");
  }
  function renderUploads() {
    $("upList").replaceChildren(...uploads.map((u) => {
      const bar = el("div", { class: "g-bar" });
      const received = u.job ? u.job.received : 0;
      bar.style.width = (u.done ? 100 : (received / u.size) * 100) + "%";
      const status = u.error ? `❌ ${u.error}` : u.done ? "✅ Отправлено" : u.job ? PDUpload.statusText(u.job, u.size, fmtSize) : "в очереди…";
      return el("div", { class: "g-file" },
        el("span", { class: "g-ext" }, u.done ? "✓" : "⬆"),
        el("div", { class: "g-info" }, el("b", {}, u.name), el("small", {}, status),
          u.done || u.error ? null : el("div", { class: "progress" }, bar)));
    }));
  }
  let queue = Promise.resolve();
  function sendFiles(files) {
    for (const file of files) {
      const u = { name: file.name, size: file.size, done: false };
      uploads.push(u);
      queue = queue.then(() => sendOne(file, u));  // по одному файлу — так быстрее доходит хотя бы первый
    }
    renderUploads();
  }
  async function sendOne(file, u) {
    const { status, data } = await call(`/api/g/${ref}/files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size }),
    });
    if (status !== 200) { u.error = (data && data.detail) || `Ошибка ${status}`; renderUploads(); return; }
    u.job = new PDUpload.ChunkUpload({
      file, size: file.size, received: 0, chunkMb: upInfo.chunk_mb,
      url: (offset) => `/api/g/${ref}/files/${data.id}/data?offset=${offset}`,
      status: async () => {
        const r = await call(`/api/g/${ref}/files/${data.id}`);
        return r.status === 200 ? r.data.received : null;
      },
      onUpdate: renderUploads,
    });
    try {
      const result = await u.job.run();
      u.done = result === "done";
      if (result === "gone") u.error = "Получатель закрыл запрос";
    } catch (e) {
      u.error = e.message;
    }
    renderUploads();
    const fresh = await call(`/api/g/${ref}`);
    if (fresh.status === 200) { upInfo = fresh.data; upMeta(); }
  }
  $("upPick").addEventListener("click", () => $("upInput").click());
  $("upInput").addEventListener("change", (e) => { sendFiles([...e.target.files].filter((f) => f.size > 0)); e.target.value = ""; });
  const upDrop = $("upDrop");
  upDrop.addEventListener("dragover", (e) => { e.preventDefault(); upDrop.classList.add("over"); });
  upDrop.addEventListener("dragleave", () => upDrop.classList.remove("over"));
  upDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    upDrop.classList.remove("over");
    sendFiles([...e.dataTransfer.files].filter((f) => f.size > 0));
  });
  window.addEventListener("beforeunload", (e) => {
    if (uploads.some((u) => !u.done && !u.error)) { e.preventDefault(); e.returnValue = ""; }
  });

  function open(newRef) {
    ref = newRef;
    history.replaceState(null, "", `/g/${ref}`);
    load();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
  }

  // Код: показываем как «123 456 789», отправляем только цифры.
  $("codeInput").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
    e.target.value = digits.replace(/(\d{3})(?=\d)/g, "$1 ");
  });
  $("codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("codeInput").value.replace(/\D/g, "");
    if (code.length !== 9) return toast("В коде 9 цифр", true);
    const { status, data } = await call("/api/get/code", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (status === 200 && data.room) location.href = `/room/${data.room}`;  // код приглашения в чат
    else if (status === 200) open(data.ref);
    else toast((data && data.detail) || `Ошибка ${status}`, true);
  });
  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { status, data } = await call(`/api/g/${ref}/unlock`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("pwInput").value }),
    });
    if (status === 200) { $("pwInput").value = ""; open(ref); }
    else toast((data && data.detail) || `Ошибка ${status}`, true);
  });

  // Чаты, куда этот браузер уже входил по коду, — чтобы было легко вернуться.
  async function loadRooms() {
    const { status, data } = await call("/api/guest/rooms");
    if (status !== 200 || !data.rooms.length) return;
    $("roomsList").replaceChildren(...data.rooms.map((r) => el("a", { class: "g-file g-room", href: `/room/${r.id}` },
      el("span", { class: "g-ext g-ava" }, (r.title.trim()[0] || "?").toUpperCase()),
      el("div", { class: "g-info" }, el("b", {}, r.title),
        el("small", {}, r.last ? (r.last.sender === "guest" ? "Вы: " : "") + r.last.preview : "напиши первым")),
      r.unread ? el("span", { class: "g-badge" }, String(r.unread)) : null)));
    $("roomsCard").hidden = false;
  }

  if (ref) open(ref);
  else { show("codeCard"); loadRooms(); }
})();
