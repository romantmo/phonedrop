// PhoneDrop — «👥 Люди»: список чатов с людьми (у владельца — на телефоне и на компьютере).
// «Новый чат» → страница чата с кодом приглашения. Собеседник вводит код — и вы переписываетесь.
"use strict";

window.PDPeople = (() => {
  const { el, api, toast, fmtTime } = PD;
  const ROLE = () => document.body.dataset.role;
  const NAME_KEY = "pd-share-name";   // как подписываться (общий с «Обменом с людьми»)
  let box = null;
  let data = null;
  let formOpen = false;
  let formNode = null;
  let onUnread = () => {};
  let timer = null;

  function url(id, fresh) {
    return `/room/${id}` + (fresh ? "?invite=1" : "");
  }

  // На компьютере чат открывается в новой вкладке: эта вкладка (и «чужой» компьютер) остаётся на месте.
  function open(id, fresh) {
    if (ROLE() === "pc") {
      const w = window.open(url(id, fresh), "_blank");
      if (w) w.opener = null;
      else toast("Браузер не дал открыть вкладку — нажми на чат в списке", true);
    } else {
      location.href = url(id, fresh);
    }
  }

  function savedName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
  }

  async function create(form) {
    const title = form.title.value.trim();
    const ownerName = form.owner.value.trim();
    if (!title) { form.title.focus(); return toast("Напиши, как зовут собеседника", true); }
    try { localStorage.setItem(NAME_KEY, ownerName); } catch { /* не важно */ }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const { room } = await api(ROLE(), "/api/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, owner_name: ownerName }),
      });
      formOpen = false;
      open(room.id, true);
      refresh();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function row(r) {
    let preview;
    if (!r.joined) preview = r.invite_expires ? "⏳ ждёт входа по коду" : "ещё не вошёл — открой чат и получи код";
    else if (r.last) preview = (r.last.sender === "owner" ? "Вы: " : "") + r.last.preview;
    else preview = "вошёл в чат — напиши первым";
    const attrs = { class: "pp-item", href: url(r.id) };
    if (ROLE() === "pc") Object.assign(attrs, { target: "_blank", rel: "noopener" });
    return el("a", attrs,
      el("div", { class: "pp-avatar" }, (r.title.trim()[0] || "?").toUpperCase(), r.online ? el("span", { class: "online" }) : null),
      el("div", { class: "pp-main" },
        el("div", { class: "pp-row" },
          el("b", { class: "pp-name" }, r.title),
          el("span", { class: "pp-time" }, r.last ? fmtTime(r.last.created) : "")),
        el("div", { class: "pp-row" },
          el("span", { class: "pp-preview" + (r.joined ? "" : " wait") }, preview),
          r.unread ? el("span", { class: "badge" }, String(r.unread)) : null)));
  }

  function render() {
    if (!box) return;
    const parts = [];
    if (formOpen) {
      if (!formNode) {  // форму создаём один раз — обновление списка не сотрёт то, что уже напечатано
        const form = el("form", { class: "pp-form", onsubmit: (e) => { e.preventDefault(); create(form); } },
          el("label", {}, "Как зовут собеседника?",
            el("input", { name: "title", maxlength: "40", placeholder: "Например: Саша", autocomplete: "off" })),
          el("label", {}, "Как подписать тебя для него?",
            el("input", { name: "owner", maxlength: "40", placeholder: "Например: Роман", autocomplete: "off" })),
          el("div", { class: "pp-form-actions" },
            el("button", { class: "btn primary", type: "submit" }, "Создать и получить код"),
            el("button", { class: "btn", type: "button", onclick: () => { formOpen = false; render(); } }, "Отмена")));
        form.owner.value = savedName();
        formNode = form;
        setTimeout(() => form.title.focus(), 50);
      }
      parts.push(formNode);
    } else {
      formNode = null;
      parts.push(el("button", { class: "btn primary block pp-new", type: "button",
        onclick: () => { formOpen = true; render(); } }, "💬 Новый чат с человеком"));
    }
    const rooms = data ? data.rooms : [];
    if (rooms.length) {
      parts.push(el("div", { class: "pp-list" }, ...rooms.map(row)));
    } else if (data) {
      parts.push(el("div", { class: "empty pp-empty" },
        el("div", { class: "big" }, "🌍"), el("b", {}, "Переписка с людьми по коду"),
        "Друг в другой стране? Создай чат — получишь код из 9 цифр. Друг вводит его на сайте и сразу пишет тебе: " +
        "без регистрации, с фото, голосовыми и файлами до 10 ГБ."));
    }
    if (data) {
      parts.push(el("p", { class: "pp-note" },
        `🔒 Текст хранится, пока не закроешь чат. Файлы — ${data.file_ttl_hours} ч, потом удаляются сами. ` +
        `Чат без сообщений ${data.idle_days} дней закрывается сам.`));
    }
    box.replaceChildren(...parts);
  }

  async function refresh() {
    try {
      data = await api(ROLE(), "/api/rooms");
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
      return;
    }
    onUnread(data.rooms.reduce((n, r) => n + r.unread, 0));
    render();
  }

  return {
    mount(container) { box = container; render(); refresh(); },
    refresh,
    refreshSoon() { clearTimeout(timer); timer = setTimeout(refresh, 300); },
    onUnread(fn) { onUnread = fn; },
  };
})();
