// PhoneDrop — чат «этот компьютер ↔ другой мой компьютер»: большие файлы (до 10 ГБ).
// Файл режется на части по 8 МБ и уходит на сервер по очереди. Оборвалась связь —
// повторяем с того места, где остановились. Закрыли вкладку — выбираешь тот же файл
// ещё раз, и загрузка продолжается. На сервере файл живёт сутки.
"use strict";

window.PDPcChat = (() => {
  const { $, el, toast, api, fmtSize, fmtTime } = PD;
  const ROLE = "pc";
  let info = null;            // ответ /api/transfers: входящие, исходящие, лимиты
  let devices = [];           // другие мои компьютеры
  let peer = null;            // id компьютера, чат с которым открыт (null — закрыт)
  const unread = new Set();   // компьютеры, от которых пришло новое, пока их чат был закрыт
  const active = new Map();   // id передачи → её загрузка (PDUpload.ChunkUpload)
  let lastIn = null;
  const listeners = [];
  let onNew = () => {};

  const changed = () => listeners.forEach((fn) => fn());

  function fmtLeft(expires) {
    const h = Math.max(0, (expires * 1000 - Date.now()) / 3600e3);
    return h >= 1 ? tx("удалится через {0} ч", Math.floor(h)) : tx("удалится через {0} мин", Math.max(1, Math.round(h * 60)));
  }

  // ---------- данные с сервера
  async function refresh() {
    try {
      const [list, devs] = await Promise.all([api(ROLE, "/api/transfers"), api(ROLE, "/api/pc/devices")]);
      info = list;
      devices = devs.devices;
      if (lastIn) {
        for (const t of list.incoming.filter((x) => !lastIn.includes(x.id))) {
          if (t.peer !== peer || document.hidden) unread.add(t.peer);
          onNew(t);
        }
      }
      lastIn = list.incoming.map((t) => t.id);
      render();
      changed();
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
    }
  }

  // ---------- лента чата с выбранным компьютером
  function items() {
    if (!info || !peer) return [];
    return [...info.incoming, ...info.outgoing].filter((t) => t.peer === peer).sort((a, b) => a.created - b.created);
  }

  function fileRow(t, status) {
    const ext = (t.name.includes(".") ? t.name.split(".").pop() : "file").slice(0, 4);
    const body = [el("div", { class: "ext" }, ext),
      el("div", { class: "finfo" }, el("div", { class: "fname" }, t.name), el("div", { class: "fsize" }, status))];
    return t.url && t.direction === "in"
      ? el("a", { class: "file-row", href: t.url, download: t.name, title: tx("Скачать") }, ...body)
      : el("div", { class: "file-row" }, ...body);
  }

  function bubble(t) {
    const out = t.direction === "out";
    const job = active.get(t.id);
    let status;
    if (!out) status = `${fmtSize(t.size)} · ${fmtLeft(t.expires)}`;
    else if (t.done) status = tx("{0} · ✅ доставлено · {1}", fmtSize(t.size), fmtLeft(t.expires));
    else if (!job) status = tx("⏸ Загрузка прервана — выбери этот же файл, чтобы продолжить");
    else status = PDUpload.statusText(job, t.size, fmtSize);
    const actions = el("div", { class: "actions" });
    if (!out) actions.append(el("a", { href: t.url, download: t.name }, tx("Скачать")));
    if (out && !t.done) {
      if (job && job.state !== "paused") actions.append(el("button", { type: "button", onclick: () => job.pause() }, tx("⏸ Пауза")));
      else if (job) actions.append(el("button", { type: "button", onclick: () => resume(t) }, tx("▶ Продолжить")));
      else actions.append(el("button", { type: "button", onclick: () => pickToResume(t) }, tx("📂 Выбрать файл")));
    }
    actions.append(el("button", { type: "button", class: "del", onclick: () => remove(t) }, out && !t.done ? tx("Отменить") : tx("Удалить")));
    const parts = [fileRow(t, status)];
    if (out && !t.done) parts.push(el("div", { class: "progress" }, el("div", { class: "tr-bar" })));
    parts.push(actions, el("div", { class: "meta" }, fmtTime(t.created)));
    return el("div", { class: "msg " + (out ? "out" : "in"), id: "tr-" + t.id }, el("div", { class: "bubble kind-file" }, ...parts));
  }

  function setBar(t) {
    const bar = document.querySelector(`#tr-${t.id} .tr-bar`);
    const job = active.get(t.id);
    if (bar) bar.style.width = ((job ? job.received : t.received) / t.size) * 100 + "%";  // CSP: только через JS
  }

  function render() {
    if (!peer || !info) return;
    const d = devices.find((x) => x.id === peer);
    if (!d) { peer = null; changed(); return; }
    $("pcPeerName").textContent = d.label;
    $("pcPeerStatus").textContent = d.online ? tx("в сети") : tx("не в сети — файл дождётся");
    $("pcLimits").textContent = tx("До {0} ГБ за файл · хранится {1} ч", Math.round(info.max_mb / 1024), info.ttl_hours);
    const list = $("pcItems");
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 200;
    const rows = items();
    list.replaceChildren(...(rows.length ? rows.map(bubble) : [el("div", { class: "empty" },
      el("div", { class: "big" }, "📦"), el("b", {}, tx("Пока пусто")),
      tx("Перетащи файл в это окно или нажми «📎 Отправить файл» — он придёт на «{0}». До 10 ГБ, хранится сутки.", d.label))]));
    rows.forEach(setBar);
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  // Обновляем только одну «полоску» — без перерисовки всей ленты.
  function renderJob(id) {
    const t = info && info.outgoing.find((x) => x.id === id);
    const node = document.getElementById("tr-" + id);
    if (!t || !node) return;
    const fresh = bubble(t);
    fresh.style.animation = "none";
    node.replaceWith(fresh);
    setBar(t);
  }

  // ---------- загрузка частями (общий загрузчик из uploader.js)
  function upload(t, file) {
    const job = new PDUpload.ChunkUpload({
      file, size: t.size, received: t.received, chunkMb: info ? info.chunk_mb : 8,
      url: (offset) => `/api/transfers/${t.id}/data?offset=${offset}`,
      status: async () => {
        const fresh = (await api(ROLE, "/api/transfers")).outgoing.find((x) => x.id === t.id);
        return fresh ? fresh.received : null;
      },
      onUpdate: () => renderJob(t.id),
    });
    active.set(t.id, job);
    return job.run().then((result) => {
      if (result === "done" || result === "gone") { active.delete(t.id); refresh(); }
    }).catch((e) => {
      active.delete(t.id);
      toast(`«${t.name}»: ${e.message}`, true);
      refresh();
    });
  }

  async function resume(t) {
    const job = active.get(t.id);
    if (!job) return;
    try { job.received = (await job.status()) ?? job.received; } catch { /* как есть */ }
    upload(Object.assign({}, t, { received: job.received }), job.file);
  }

  function pickToResume(t) {
    PDUpload.pickSame(t.name, t.size, (file) => upload(t, file), toast, fmtSize);
  }

  async function remove(t) {
    if (!confirm(t.direction === "in" ? tx("Удалить файл с сервера?") : tx("Отменить передачу и удалить файл с сервера?"))) return;
    const job = active.get(t.id);
    if (job) { job.pause(); active.delete(t.id); }
    try { await api(ROLE, `/api/transfers/${t.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
    refresh();
  }

  async function send(files) {
    const to = peer;
    for (const file of [...files]) {
      if (!file.size) { toast(tx("«{0}» пустой — пропускаю", file.name), true); continue; }
      let t;
      try {
        t = await api(ROLE, "/api/transfers", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, to }),
        });
      } catch (e) {
        toast(`«${file.name}»: ${e.message}`, true);
        continue;
      }
      info.outgoing.unshift(t);
      render();
      $("pcItems").scrollTop = $("pcItems").scrollHeight;
      await upload(t, file);  // по одному файлу — так быстрее доходит хотя бы первый
    }
  }

  // ---------- кнопки и перетаскивание
  $("pcAttach").addEventListener("click", () => $("pcFileInput").click());
  $("pcFileInput").addEventListener("change", (e) => { send(e.target.files); e.target.value = ""; });
  const zone = $("pcMain");
  let depth = 0;
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; $("pcDrop").hidden = false; });
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("pcDrop").hidden = true; } });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    $("pcDrop").hidden = true;
    if (e.dataTransfer.files.length) send(e.dataTransfer.files);
  });
  // Не даём случайно закрыть вкладку посреди загрузки.
  window.addEventListener("beforeunload", (e) => {
    if ([...active.values()].some((j) => j.state !== "paused")) { e.preventDefault(); e.returnValue = ""; }
  });
  setInterval(() => { if (peer && !active.size) render(); }, 60000);  // «удалится через…»

  return {
    refresh,
    devices: () => devices,
    unread: (id) => unread.has(id),
    show(id) { peer = id; unread.delete(id); render(); changed(); },
    hide() { peer = null; },
    current: () => peer,
    onChange(fn) { listeners.push(fn); },
    onIncoming(fn) { onNew = fn; },
  };
})();
