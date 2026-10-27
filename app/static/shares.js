// PhoneDrop — «🌍 Другому человеку»: посылка по ссылке или коду (телефон и компьютер).
// Получатель открывает ссылку или вводит 9-значный код на drop.rbgen.com/get — без регистрации.
"use strict";

window.PDShares = (() => {
  const { el, toast, api, fmtSize, canShareFiles } = PD;
  const ROLE = document.body.dataset.role || "phone";
  const HOURS = [[1, "1 час"], [6, "6 часов"], [24, "24 часа"]];
  let box = null;           // куда рисуем
  let data = null;          // ответ /api/shares
  let picked = [];
  const opts = { hours: 24, password: "", once: false, notify: true, name: "", kind: "send", max_mb: 10240 };
  const LIMITS = [[1024, "1 ГБ"], [5120, "5 ГБ"], [10240, "10 ГБ"]];
  try { opts.name = localStorage.getItem("pd-share-name") || ""; } catch { /* не страшно */ }
  const jobs = new Map();   // id файла → загрузчик
  let fresh = null;         // только что созданная посылка (крупная карточка с кодом)

  // Ссылку и код сервер показывает один раз (у себя хранит только «отпечатки»),
  // поэтому запоминаем их в этом браузере, чтобы можно было скопировать позже.
  const KEY = "pd-share-links";
  function saved() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } }
  function remember(id, links) {
    try { localStorage.setItem(KEY, JSON.stringify({ ...saved(), [id]: links })); } catch { /* не страшно */ }
  }

  function fmtLeft(expires) {
    const min = Math.max(0, (expires * 1000 - Date.now()) / 60000);
    return min >= 60 ? `ещё ${Math.floor(min / 60)} ч ${Math.round(min % 60)} мин` : `ещё ${Math.max(1, Math.round(min))} мин`;
  }

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} скопирован${what === "Код" ? "" : "а"}`); }
    catch { toast("Не получилось скопировать — выдели и скопируй вручную", true); }
  }

  // ---------- данные
  async function refresh() {
    if (!box) return;
    try {
      data = await api(ROLE, "/api/shares");
      render();
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
    }
  }

  // ---------- загрузка файлов в посылку
  async function uploadInto(share, files) {
    for (const file of files) {
      let f;
      try {
        f = await api(ROLE, `/api/shares/${share.id}/files`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, mime: file.type }),
        });
      } catch (e) {
        toast(`«${file.name}»: ${e.message}`, true);
        continue;
      }
      await runJob(share.id, f, file);
    }
    refresh();
  }

  function runJob(sid, f, file) {
    const job = new PDUpload.ChunkUpload({
      file, size: f.size, received: f.received, chunkMb: data ? data.chunk_mb : 8,
      url: (offset) => `/api/shares/${sid}/files/${f.id}/data?offset=${offset}`,
      status: async () => {
        const s = (await api(ROLE, "/api/shares")).shares.find((x) => x.id === sid);
        const ff = s && s.files.find((x) => x.id === f.id);
        return ff ? ff.received : null;
      },
      onUpdate: () => updateRow(f.id),
    });
    jobs.set(f.id, job);
    if (data) {  // сразу показываем строку файла в списке
      const s = data.shares.find((x) => x.id === sid);
      if (s && !s.files.some((x) => x.id === f.id)) { s.files.push(f); render(); }
    }
    return job.run().then((r) => { if (r !== "paused") jobs.delete(f.id); })
      .catch((e) => { jobs.delete(f.id); toast(`«${f.name}»: ${e.message}`, true); });
  }

  // ---------- создание посылки
  async function create() {
    const request = opts.kind === "request";
    if (!request && !picked.length) return toast("Сначала выбери файлы", true);
    const files = request ? [] : picked.slice();
    let res;
    try {
      res = await api(ROLE, "/api/shares", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
    } catch (e) {
      return toast(e.message, true);
    }
    remember(res.share.id, { link: res.link, code: res.code, get_url: res.get_url });
    fresh = res.share.id;
    picked = request ? picked : [];
    opts.password = "";
    data.shares.unshift(res.share);
    render();
    if (files.length) await uploadInto(res.share, files);
  }

  // ---------- отрисовка
  // Файл, который прислали тебе в «запрос»: скачать или удалить.
  function inboxRow(sid, f) {
    const bar = el("div", { class: "sh-bar" });
    bar.style.width = (f.received / f.size) * 100 + "%";
    return el("div", { class: "sh-file", id: "shf-" + f.id },
      el("div", { class: "sh-finfo" },
        el("b", {}, f.name),
        el("small", {}, f.done ? fmtSize(f.size) : `загружается: ${Math.floor((f.received / f.size) * 100)}% из ${fmtSize(f.size)}`),
        f.done ? null : el("div", { class: "progress" }, bar)),
      el("div", { class: "sh-factions" },
        f.done ? el("a", { class: "btn primary sh-dl", href: `/api/shares/${sid}/files/${f.id}/download`, download: f.name }, "⬇") : null,
        el("button", { type: "button", class: "sh-mini danger", "aria-label": "Удалить файл", onclick: async () => {
          if (!confirm(`Удалить «${f.name}»?`)) return;
          try { await api(ROLE, `/api/shares/${sid}/files/${f.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
          refresh();
        } }, "✕")));
  }

  function fileRow(sid, f) {
    const job = jobs.get(f.id);
    let status;
    if (f.done && !job) status = f.downloads ? `✅ Скачан ${f.downloads} ${f.downloads === 1 ? "раз" : "раза"}` : "Ждёт получателя";
    else if (job && job.state !== "done") status = PDUpload.statusText(job, f.size, fmtSize);
    else if (job) status = "Загружено";
    else status = "⏸ Загрузка прервана — выбери этот же файл ещё раз";
    const actions = [];
    if (job && job.state !== "paused" && job.state !== "done") {
      actions.push(el("button", { type: "button", class: "sh-mini", onclick: () => job.pause() }, "⏸"));
    } else if (job && job.state === "paused") {
      actions.push(el("button", { type: "button", class: "sh-mini", onclick: () => runJob(sid, f, job.file) }, "▶"));
    } else if (!f.done) {
      actions.push(el("button", { type: "button", class: "sh-mini", onclick: () =>
        PDUpload.pickSame(f.name, f.size, (file) => runJob(sid, f, file), toast, fmtSize) }, "📂"));
    }
    actions.push(el("button", { type: "button", class: "sh-mini danger", "aria-label": "Убрать файл", onclick: async () => {
      if (job) job.pause();
      jobs.delete(f.id);
      try { await api(ROLE, `/api/shares/${sid}/files/${f.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
      refresh();
    } }, "✕"));
    const bar = el("div", { class: "sh-bar" });
    const pct = ((job ? job.received : f.received) / f.size) * 100;
    bar.style.width = (f.done ? 100 : pct) + "%";
    return el("div", { class: "sh-file", id: "shf-" + f.id },
      el("div", { class: "sh-finfo" },
        el("b", {}, f.name),
        el("small", {}, `${fmtSize(f.size)} · ${status}`),
        f.done && !job ? null : el("div", { class: "progress" }, bar)),
      el("div", { class: "sh-factions" }, ...actions));
  }

  function updateRow(fid) {
    const row = document.getElementById("shf-" + fid);
    if (!row || !data) return;
    for (const s of data.shares) {
      const f = s.files.find((x) => x.id === fid);
      if (f) { row.replaceWith(fileRow(s.id, f)); return; }
    }
  }

  function shareCard(s) {
    const links = saved()[s.id];
    const big = s.id === fresh;
    const request = s.kind === "request";
    const addInput = el("input", { type: "file", multiple: true, hidden: true });
    addInput.addEventListener("change", () => { uploadInto(s, [...addInput.files]); addInput.value = ""; });
    const head = links ? [
      el("div", { class: "sh-code" + (big ? " big" : "") },
        el("small", {}, "Код"), el("b", {}, links.code),
        el("button", { type: "button", class: "btn", onclick: () => copy(links.code.replace(/ /g, ""), "Код") }, "Копировать")),
      el("div", { class: "sh-link" },
        el("input", { type: "text", readonly: true, value: links.link, "aria-label": "Ссылка", onclick: (e) => e.target.select() }),
        el("button", { type: "button", class: "btn", onclick: () => copy(links.link, "Ссылка") }, "Копировать"),
        canShareFiles || navigator.share ? el("button", { type: "button", class: "btn primary", onclick: () =>
          navigator.share({ title: "PhoneDrop", text: "Файлы для тебя:", url: links.link }).catch(() => {}) }, "📤") : null),
      big ? el("p", { class: "sh-say" }, "Скажи человеку: «Зайди на ", el("b", {}, links.get_url.replace(/^https?:\/\//, "")),
        " и введи код ", el("b", {}, links.code), "»", request ? " — и он сможет загрузить файлы тебе."
          : s.has_password ? " — и назови пароль." : ".") : null,
    ] : [
      el("p", { class: "sh-say" }, "Ссылка и код показываются один раз. Если потерял — сделай новые (старые перестанут работать)."),
      el("button", { type: "button", class: "btn", onclick: async () => {
        try {
          const r = await api(ROLE, `/api/shares/${s.id}/rotate`, { method: "POST" });
          remember(s.id, { link: r.link, code: r.code, get_url: r.get_url });
          fresh = s.id;
          render();
        } catch (e) { toast(e.message, true); }
      } }, "🔄 Новая ссылка и код"),
    ];
    const badges = [request ? "📥 запрос файлов" : "📤 посылка", `⏳ ${fmtLeft(s.expires)}`];
    if (request) badges.push(`до ${fmtSize(s.max_bytes)}`);
    if (s.has_password) badges.push("🔒 с паролем");
    if (s.once) badges.push("🔥 удалится после скачивания");
    if (s.notify) badges.push(request ? "🔔 сообщу о новых файлах" : "🔔 сообщу о скачивании");
    return el("section", { class: "sh-card" + (big ? " fresh" : "") },
      el("div", { class: "sh-badges" }, ...badges.map((b) => el("span", {}, b))),
      ...head,
      el("div", { class: "sh-files" }, ...(s.files.length ? s.files.map((f) => (request ? inboxRow : fileRow)(s.id, f))
        : [el("p", { class: "sh-empty" }, request ? "Пока ничего не прислали. Появится здесь — и придёт уведомление." : "Файлов пока нет — добавь.")])),
      el("div", { class: "sh-actions" },
        request ? null : el("button", { type: "button", class: "btn", onclick: () => addInput.click() }, "➕ Добавить файлы"),
        el("button", { type: "button", class: "btn danger", onclick: async () => {
          if (!confirm("Удалить посылку? Ссылка и код перестанут работать.")) return;
          for (const f of s.files) { const j = jobs.get(f.id); if (j) j.pause(); jobs.delete(f.id); }
          try { await api(ROLE, `/api/shares/${s.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
          refresh();
        } }, request ? "Закрыть запрос" : "Удалить посылку"),
        addInput));
  }

  function createCard() {
    const input = el("input", { type: "file", multiple: true, hidden: true });
    input.addEventListener("change", () => { picked.push(...[...input.files].filter((f) => f.size > 0)); input.value = ""; render(); });
    const drop = el("div", { class: "sh-drop" },
      el("span", {}, ROLE === "pc" ? "📂 Перетащи файлы сюда" : "Выбери, что отправить"),
      el("button", { type: "button", class: "btn", onclick: () => input.click() }, ROLE === "pc" ? "или выбери на компьютере" : "📂 Выбрать файлы"),
      input);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      picked.push(...[...e.dataTransfer.files].filter((f) => f.size > 0));
      render();
    });
    const who = el("input", { type: "text", placeholder: "Например: Роман", value: opts.name, maxlength: "40",
      autocomplete: "off", "aria-label": "Как тебя назвать получателю" });
    who.addEventListener("input", () => {
      opts.name = who.value;
      try { localStorage.setItem("pd-share-name", who.value); } catch { /* не страшно */ }
    });
    const pw = el("input", { type: "text", placeholder: "Пароль (не обязательно)", value: opts.password,
      autocomplete: "off", maxlength: "64", "aria-label": "Пароль" });
    pw.addEventListener("input", () => (opts.password = pw.value));
    const check = (key, label) => {
      const c = el("input", { type: "checkbox", checked: opts[key] });
      c.addEventListener("change", () => (opts[key] = c.checked));
      return el("label", { class: "sh-check" }, c, el("span", {}, label));
    };
    const total = picked.reduce((n, f) => n + f.size, 0);
    const request = opts.kind === "request";
    const modes = el("div", { class: "seg sh-modes" },
      el("button", { type: "button", class: request ? "" : "on", onclick: () => { opts.kind = "send"; render(); } }, "📤 Отправить файлы"),
      el("button", { type: "button", class: request ? "on" : "", onclick: () => { opts.kind = "request"; render(); } }, "📥 Попросить файлы"));
    if (request) {
      return el("section", { class: "sh-card" },
        modes,
        el("p", { class: "sh-say" }, "Получишь код и ссылку. Человек вводит код на сайте и загружает файлы тебе — без регистрации. Видеть или скачивать что-то он не сможет."),
        el("h4", {}, "Человек увидит: «Отправь файлы для …»"),
        who,
        el("h4", {}, "Сколько ждать файлы"),
        el("div", { class: "seg" }, ...HOURS.map(([h, label]) => el("button", { type: "button", class: opts.hours === h ? "on" : "",
          onclick: () => { opts.hours = h; render(); } }, label))),
        el("h4", {}, "Сколько можно прислать всего"),
        el("div", { class: "seg" }, ...LIMITS.map(([mb, label]) => el("button", { type: "button", class: opts.max_mb === mb ? "on" : "",
          onclick: () => { opts.max_mb = mb; render(); } }, label))),
        check("notify", "Сообщить мне, когда пришлют файл"),
        el("button", { type: "button", class: "btn primary block sh-create", onclick: create }, "📥 Создать код для отправки мне"));
    }
    return el("section", { class: "sh-card" },
      modes,
      el("h3", {}, "Новая посылка"),
      drop,
      picked.length ? el("div", { class: "sh-files" }, ...picked.map((f, i) => el("div", { class: "sh-file" },
        el("div", { class: "sh-finfo" }, el("b", {}, f.name), el("small", {}, fmtSize(f.size))),
        el("button", { type: "button", class: "sh-mini danger", onclick: () => { picked.splice(i, 1); render(); } }, "✕")))) : null,
      el("h4", {}, "Получатель увидит: «Файлы от …»"),
      who,
      el("h4", {}, "Сколько хранить"),
      el("div", { class: "seg" }, ...HOURS.map(([h, label]) => el("button", { type: "button", class: opts.hours === h ? "on" : "",
        onclick: () => { opts.hours = h; render(); } }, label))),
      el("h4", {}, "Защита"),
      pw,
      check("once", "Удалить файл после скачивания"),
      check("notify", "Сообщить мне, когда скачают"),
      el("button", { type: "button", class: "btn primary block sh-create", disabled: !picked.length, onclick: create },
        picked.length ? `🔗 Создать ссылку и код (${picked.length} · ${fmtSize(total)})` : "🔗 Создать ссылку и код"),
      data ? el("p", { class: "sh-limits" }, `До ${Math.round(data.max_mb / 1024)} ГБ за файл · занято ${fmtSize(data.used)} из ${Math.round(data.quota_mb / 1024)} ГБ`) : null);
  }

  function render() {
    if (!box || !data) return;
    const focused = document.activeElement && box.contains(document.activeElement) && document.activeElement.type === "text";
    if (focused) return;  // не мешаем вводить пароль
    box.replaceChildren(...[
      ROLE === "pc" ? el("p", { class: "sh-intro" }, "Обмен файлами с человеком, которого нет в твоих устройствах: в другой стране, у клиента, у друга. По ссылке или коду — без регистрации, в обе стороны.") : null,
      ...data.shares.map(shareCard),
      createCard()].filter(Boolean));
  }

  function mount(container) {
    box = container;
    refresh();
  }

  window.addEventListener("beforeunload", (e) => {
    if ([...jobs.values()].some((j) => j.state === "uploading" || j.state === "retry")) { e.preventDefault(); e.returnValue = ""; }
  });

  return { mount, refresh };
})();
