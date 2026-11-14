// PhoneDrop — «👥 Пользователи» (только для администратора).
// Админ добавляет Gmail родных и коллег: они входят через Google, создают свои чаты с людьми
// и пользуются инструментами. Убрал адрес — доступ закрывается сразу на всех устройствах.
"use strict";

window.PDAdmin = (() => {
  const { el, api, toast, fmtTime } = PD;
  const ROLE = () => document.body.dataset.role;

  function open() {
    const close = () => backdrop.remove();
    const list = el("div", { class: "ad-list" }, el("p", { class: "pp-hint" }, tx("Загружаю…")));
    const input = el("input", { type: "email", name: "email", placeholder: tx("например, mama@gmail.com"),
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": tx("Адрес Gmail") });
    const form = el("form", { class: "pp-form" },
      el("h3", {}, tx("👥 Пользователи")),
      el("p", { class: "pp-hint" }, tx("Добавь Gmail человека — он сможет войти через Google, создавать свои чаты и пользоваться инструментами. Твои чаты и компьютеры он не видит.")),
      el("div", { class: "ad-add" }, input, el("button", { class: "btn primary", type: "submit" }, tx("Добавить"))),
      list,
      el("div", { class: "pp-form-actions" }, el("button", { class: "btn", type: "button", onclick: close }, tx("Закрыть"))));

    function render(data) {
      const rows = [];
      for (const email of data.admins) {
        rows.push(el("div", { class: "ad-row" },
          el("div", { class: "ad-info" }, el("b", {}, email), el("small", {}, tx("👑 администратор"))), null));
      }
      for (const u of data.users) {
        const status = u.signed_in ? tx("входил, последний раз {0}", fmtTime(u.last_active)) : tx("ещё не входил");
        rows.push(el("div", { class: "ad-row" },
          el("div", { class: "ad-info" }, el("b", {}, u.email), el("small", {}, status)),
          el("button", { type: "button", class: "ad-del", "aria-label": tx("Убрать {0}", u.email), onclick: () => remove(u.email) }, tx("Убрать"))));
      }
      if (!data.users.length) rows.push(el("p", { class: "pp-hint" }, tx("Пока никого не добавил.")));
      list.replaceChildren(...rows);
    }

    async function load() {
      try { render(await api(ROLE(), "/api/admin/users")); } catch (e) { toast(e.message, true); close(); }
    }

    async function remove(email) {
      if (!confirm(tx("Убрать {0}? Он сразу выйдет на всех устройствах, его чаты и файлы удалятся.", email))) return;
      try { render(await api(ROLE(), `/api/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" })); toast(tx("Доступ закрыт")); }
      catch (e) { toast(e.message, true); }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = input.value.trim();
      if (!email) return input.focus();
      try {
        render(await api(ROLE(), "/api/admin/users", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
        }));
        input.value = "";
        toast(tx("Готово: {0} может войти через Google на drop.rbgen.com", email));
      } catch (err) {
        toast(err.message, true);
      }
    });

    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => e.target === backdrop && close() },
      el("div", { class: "sheet pp-sheet" }, form));
    document.body.append(backdrop);
    load();
  }

  return { open };
})();
