// PhoneDrop — чаты с людьми (по коду): данные для общего списка «Чаты» и окно «Новый чат с человеком».
// Сам список рисуют phone.js и desktop.js — люди стоят там рядом с компьютерами.
"use strict";

window.PDPeople = (() => {
  const { el, api, toast } = PD;
  const ROLE = () => document.body.dataset.role;
  const NAME_KEY = "pd-share-name";   // как подписываться для собеседника (запоминаем)
  let data = null;
  let timer = null;
  const listeners = [];

  function url(id, fresh) {
    return `/room/${id}` + (fresh ? "?invite=1" : "");
  }

  // На компьютере чат с человеком открывается в новой вкладке: эта вкладка (и «чужой» компьютер) остаётся на месте.
  function open(id, fresh) {
    if (ROLE() === "pc") {
      const w = window.open(url(id, fresh), "_blank");
      if (w) w.opener = null;
      else toast("Браузер не дал открыть вкладку — нажми на чат в списке", true);
    } else {
      location.href = url(id, fresh);
    }
  }

  // Вторая строка в списке: последнее сообщение или «ждёт входа по коду».
  function preview(r) {
    if (!r.joined) return r.invite_expires ? "⏳ ждёт входа по коду" : "ещё не вошёл — открой чат и получи код";
    const me = r.guest ? "guest" : "owner";  // r.guest — я вошёл в этот чат по чужому коду
    if (r.last) return (r.last.sender === me ? "Вы: " : "") + r.last.preview;
    return "вошёл в чат — напиши первым";
  }

  async function refresh() {
    try {
      data = await api(ROLE(), "/api/rooms");
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
      return;
    }
    listeners.forEach((fn) => fn(data.rooms));
  }

  // ---------- «Новый чат с человеком»: имя → код приглашения на странице чата
  function savedName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
  }

  function askNewChat() {
    const close = () => backdrop.remove();
    const form = el("form", { class: "pp-form" },
      el("h3", {}, "👤 Чат с человеком"),
      el("p", { class: "pp-hint" }, "Получишь код из 9 цифр. Собеседник вводит его на сайте — регистрация ему не нужна."),
      el("label", {}, "Как зовут собеседника?",
        el("input", { name: "title", maxlength: "40", placeholder: "Например: Саша", autocomplete: "off" })),
      el("label", {}, "Как подписать тебя для него?",
        el("input", { name: "owner", maxlength: "40", placeholder: "Например: Роман", autocomplete: "off" })),
      el("div", { class: "pp-form-actions" },
        el("button", { class: "btn primary", type: "submit" }, "Создать и получить код"),
        el("button", { class: "btn", type: "button", onclick: close }, "Отмена")));
    form.owner.value = savedName();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
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
        close();
        open(room.id, true);
        refresh();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => e.target === backdrop && close() },
      el("div", { class: "sheet pp-sheet" }, form));
    document.body.append(backdrop);
    setTimeout(() => form.title.focus(), 80);
  }

  return {
    refresh,
    refreshSoon() { clearTimeout(timer); timer = setTimeout(refresh, 300); },
    rooms: () => (data ? data.rooms : []),
    loaded: () => !!data,
    info: () => data,
    onChange(fn) { listeners.push(fn); },
    open,
    url,
    preview,
    askNewChat,
  };
})();
