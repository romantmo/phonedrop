// PhoneDrop — страница получателя: код или ссылка → (пароль) → список файлов.
// Регистрация не нужна. Пока посылка открыта, отправитель может докладывать файлы —
// страница проверяет новые файлы каждые 5 секунд.
"use strict";

(() => {
  const { $, el, toast, fmtSize } = PD;
  let ref = (location.pathname.match(/^\/g\/([\w.-]+)$/) || [])[1] || null;
  let timer = null;

  function show(id) {
    for (const card of ["codeCard", "pwCard", "filesCard", "errorCard"]) $(card).hidden = card !== id;
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
    if (status === 200) open(data.ref);
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

  if (ref) open(ref);
  else show("codeCard");
})();
