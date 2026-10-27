// PhoneDrop — «📦 Передачи»: большие файлы (до 10 ГБ) между моими компьютерами.
// Файл режется на части по 8 МБ и уходит на сервер по очереди. Оборвалась связь —
// повторяем с того места, где остановились. Закрыли вкладку — выбираешь тот же файл
// ещё раз, и загрузка продолжается. На сервере файл живёт сутки.
"use strict";

window.PDTransfers = (() => {
  const { $, el, toast, api, fmtSize } = PD;
  const ROLE = "pc";
  let info = null;        // лимиты с сервера
  let devices = [];
  let target = null;      // id компьютера-получателя
  let picked = [];        // выбранные, но ещё не отправленные файлы
  const active = new Map(); // id передачи → состояние загрузки
  let onNew = () => {};

  function fmtLeft(expires) {
    const h = Math.max(0, (expires * 1000 - Date.now()) / 3600e3);
    return h >= 1 ? `удалится через ${Math.floor(h)} ч` : `удалится через ${Math.max(1, Math.round(h * 60))} мин`;
  }

  // ---------- данные с сервера
  let lastIn = null;
  async function refresh() {
    try {
      const [list, devs] = await Promise.all([api(ROLE, "/api/transfers"), api(ROLE, "/api/pc/devices")]);
      info = list;
      devices = devs.devices;
      if (!devices.some((d) => d.id === target)) target = devices[0] ? devices[0].id : null;
      const inIds = list.incoming.map((t) => t.id);
      if (lastIn) {
        const fresh = list.incoming.filter((t) => !lastIn.includes(t.id));
        fresh.forEach((t) => onNew(t));
      }
      lastIn = inIds;
      render();
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
    }
  }

  // ---------- отрисовка
  function renderTargets() {
    const box = $("trTargets");
    if (!devices.length) {
      box.replaceChildren(el("p", { class: "tr-empty" },
        "Других компьютеров пока нет. Открой PhoneDrop на втором компьютере и отсканируй QR-код телефоном — он появится здесь."));
      return;
    }
    box.replaceChildren(...devices.map((d) => el("button", {
      type: "button", class: "tr-target" + (d.id === target ? " on" : ""),
      onclick: () => { target = d.id; renderTargets(); updateSend(); },
    }, el("span", { class: "tr-dot" + (d.online ? " online" : "") }), el("span", {}, d.label),
    el("small", {}, d.online ? "в сети" : "не в сети — файл дождётся"))));
  }

  function updateSend() {
    const btn = $("trSend");
    const total = picked.reduce((n, f) => n + f.size, 0);
    btn.disabled = !picked.length || !target;
    btn.textContent = picked.length ? `Отправить (${picked.length} · ${fmtSize(total)})` : "Отправить";
  }

  function renderPicked() {
    $("trPicked").replaceChildren(...picked.map((f, i) => el("div", { class: "tr-row" },
      el("span", { class: "tr-ico" }, "📄"),
      el("div", { class: "tr-info" }, el("b", {}, f.name), el("small", {}, fmtSize(f.size))),
      el("button", { type: "button", class: "tr-x", "aria-label": "Убрать", onclick: () => {
        picked.splice(i, 1); renderPicked(); updateSend();
      } }, "✕"))));
    updateSend();
  }

  function progressRow(t) {
    const job = active.get(t.id);
    let status;
    if (t.done) status = `✅ Доставлено на «${t.to_label}» · ${fmtLeft(t.expires)}`;
    else if (!job) status = "⏸ Загрузка прервана — выбери этот же файл, чтобы продолжить";
    else status = PDUpload.statusText(job, t.size, fmtSize);
    const actions = [];
    if (!t.done && job && job.state !== "paused") {
      actions.push(el("button", { type: "button", class: "btn", onclick: () => pause(t.id) }, "⏸ Пауза"));
    } else if (!t.done && job) {
      actions.push(el("button", { type: "button", class: "btn", onclick: () => resume(t) }, "▶ Продолжить"));
    } else if (!t.done) {
      actions.push(el("button", { type: "button", class: "btn", onclick: () => pickToResume(t) }, "📂 Выбрать файл"));
    }
    actions.push(el("button", { type: "button", class: "btn danger", onclick: () => remove(t) }, "Удалить"));
    return el("div", { class: "tr-row big", id: "tr-" + t.id },
      el("span", { class: "tr-ico" }, t.done ? "📦" : "⬆️"),
      el("div", { class: "tr-info" },
        el("b", {}, t.name),
        el("small", {}, `→ ${t.to_label} · ${fmtSize(t.size)}`),
        t.done ? null : el("div", { class: "progress" }, el("div", { class: "tr-bar" })),
        el("small", { class: "tr-status" }, status)),
      el("div", { class: "tr-actions" }, ...actions));
  }

  function setBars() {  // ширину полосок ставим через JS (в HTML стилей нет — так требует наша защита CSP)
    for (const t of info ? info.outgoing : []) {
      const bar = document.querySelector(`#tr-${t.id} .tr-bar`);
      const job = active.get(t.id);
      if (bar) bar.style.width = ((job ? job.received : t.received) / t.size) * 100 + "%";
    }
  }

  function render() {
    if (!info) return;
    renderTargets();
    renderPicked();
    $("trLimits").textContent = `До ${Math.round(info.max_mb / 1024)} ГБ за файл · хранится ${info.ttl_hours} ч, потом удаляется сам · занято ${fmtSize(info.used)} из ${Math.round(info.quota_mb / 1024)} ГБ`;
    $("trIn").replaceChildren(...(info.incoming.length ? info.incoming.map((t) => el("div", { class: "tr-row big" },
      el("span", { class: "tr-ico" }, "📥"),
      el("div", { class: "tr-info" },
        el("b", {}, t.name),
        el("small", {}, `от «${t.from_label}» · ${fmtSize(t.size)} · ${fmtLeft(t.expires)}`)),
      el("div", { class: "tr-actions" },
        el("a", { class: "btn primary", href: t.url, download: t.name }, "⬇ Скачать"),
        el("button", { type: "button", class: "btn danger", onclick: () => remove(t) }, "Удалить"))))
      : [el("p", { class: "tr-empty" }, "Пока ничего. Отправь файл с другого своего компьютера — он появится здесь.")]));
    $("trOut").replaceChildren(...(info.outgoing.length ? info.outgoing.map(progressRow)
      : [el("p", { class: "tr-empty" }, "Ты ещё ничего не отправлял.")]));
    setBars();
  }

  // Обновляем только строку загрузки — без перерисовки всего экрана.
  function renderJob(id) {
    const t = info && info.outgoing.find((x) => x.id === id);
    const row = document.getElementById("tr-" + id);
    if (!t || !row) return;
    row.replaceWith(progressRow(t));
    setBars();
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
      if (result === "done") {
        active.delete(t.id);
        toast(`«${t.name}» доставлен на «${t.to_label}»`);
        refresh();
      } else if (result === "gone") {
        active.delete(t.id);
        refresh();
      }
    }).catch((e) => {
      active.delete(t.id);
      toast(`«${t.name}»: ${e.message}`, true);
      refresh();
    });
  }

  function pause(id) {
    const job = active.get(id);
    if (job) job.pause();
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
    const what = t.direction === "in" ? "Удалить файл с сервера?" : "Отменить передачу и удалить файл с сервера?";
    if (!confirm(what)) return;
    const job = active.get(t.id);
    if (job) { job.pause(); active.delete(t.id); }
    try {
      await api(ROLE, `/api/transfers/${t.id}`, { method: "DELETE" });
    } catch (e) {
      toast(e.message, true);
    }
    refresh();
  }

  async function send() {
    const files = picked.slice();
    picked = [];
    renderPicked();
    for (const file of files) {
      let t;
      try {
        t = await api(ROLE, "/api/transfers", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, to: target }),
        });
      } catch (e) {
        toast(`«${file.name}»: ${e.message}`, true);
        continue;
      }
      info.outgoing.unshift(t);
      render();
      await upload(t, file);  // по одному файлу — так быстрее доходит хотя бы первый
    }
  }

  function addFiles(list) {
    picked.push(...[...list].filter((f) => f.size > 0));
    renderPicked();
  }

  // ---------- кнопки и перетаскивание
  $("trPick").addEventListener("click", () => $("trInput").click());
  $("trInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("trSend").addEventListener("click", send);
  const zone = $("trDrop");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); addFiles(e.dataTransfer.files); });
  // Не даём случайно закрыть вкладку посреди загрузки.
  window.addEventListener("beforeunload", (e) => {
    if ([...active.values()].some((j) => j.state !== "paused")) { e.preventDefault(); e.returnValue = ""; }
  });
  setInterval(() => { if (info && !$("transfersMain").hidden && !active.size) render(); }, 60000); // «удалится через…»

  return {
    refresh,
    busy: () => [...active.values()].some((j) => j.state !== "paused"),
    onIncoming: (fn) => { onNew = fn; },
  };
})();
