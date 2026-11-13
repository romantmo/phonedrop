// PhoneDrop — «👥 Пользователи» (только для администратора).
// Админ добавляет Gmail родных и коллег: они входят через Google, создают свои чаты с людьми
// и пользуются инструментами. Убрал адрес — доступ закрывается сразу на всех устройствах.
"use strict";

window.PDAdmin = (() => {
  const { el, api, toast, fmtTime } = PD;
  const ROLE = () => document.body.dataset.role;

  function open() {
    const close = () => backdrop.remove();
    const list = el("div", { class: "ad-list" }, el("p", { class: "pp-hint" }, "Загружаю…"));
    const input = el("input", { type: "email", name: "email", placeholder: "например, mama@gmail.com",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Адрес Gmail" });
    const form = el("form", { class: "pp-form" },
      el("h3", {}, "👥 Пользователи"),
      el("p", { class: "pp-hint" }, "Добавь Gmail человека — он сможет войти через Google, создавать свои чаты и пользоваться инструментами. Твои чаты и компьютеры он не видит."),
      el("div", { class: "ad-add" }, input, el("button", { class: "btn primary", type: "submit" }, "Добавить")),
      list,
      el("div", { class: "pp-form-actions" }, el("button", { class: "btn", type: "button", onclick: close }, "Закрыть")));

    function render(data) {
      const rows = [];
      for (const email of data.admins) {
        rows.push(el("div", { class: "ad-row" },
          el("div", { class: "ad-info" }, el("b", {}, email), el("small", {}, "👑 администратор")), null));
      }
      for (const u of data.users) {
        const status = u.signed_in ? `входил, последний раз ${fmtTime(u.last_active)}` : "ещё не входил";
        rows.push(el("div", { class: "ad-row" },
          el("div", { class: "ad-info" }, el("b", {}, u.email), el("small", {}, status)),
          el("button", { type: "button", class: "ad-del", "aria-label": `Убрать ${u.email}`, onclick: () => remove(u.email) }, "Убрать")));
      }
      if (!data.users.length) rows.push(el("p", { class: "pp-hint" }, "Пока никого не добавил."));
      list.replaceChildren(...rows);
    }

    async function load() {
      try { render(await api(ROLE(), "/api/admin/users")); } catch (e) { toast(e.message, true); close(); }
    }

    async function remove(email) {
      if (!confirm(`Убрать ${email}? Он сразу выйдет на всех устройствах, его чаты и файлы удалятся.`)) return;
      try { render(await api(ROLE(), `/api/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" })); toast("Доступ закрыт"); }
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
        toast(`Готово: ${email} может войти через Google на drop.rbgen.com`);
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
