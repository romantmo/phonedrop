// Языки PhoneDrop: русский, English, עברית.
//
// Как это работает (для чайника):
// - В коде все тексты написаны по-русски и обёрнуты в tx("…"). tx ищет перевод в словаре
//   (файл i18n-words.js) и возвращает его. Нет перевода — остаётся русский текст.
// - Подстановки: tx("Файлов: {0}", 5) → «Файлов: 5» / «Files: 5».
// - Тексты, которые написаны прямо в HTML (кнопки, заголовки), переводятся один раз при загрузке.
// - Язык: выбор человека в меню «🌐 Язык», иначе язык телефона/браузера. Иврит — справа налево.
// - Выбранный язык кладём в cookie pd_lang, чтобы сервер отвечал (ошибки, уведомления) на нём же.
(() => {
  const NAMES = { ru: "Русский", en: "English", he: "עברית" };
  const LOCALES = { ru: "ru-RU", en: "en-GB", he: "he-IL" };
  const WORDS = window.PD_WORDS || {};

  function detect() {
    for (const tag of navigator.languages || [navigator.language || ""]) {
      const code = String(tag).slice(0, 2).toLowerCase();
      if (["ru", "uk", "be", "kk"].includes(code)) return "ru";
      if (code === "he" || code === "iw") return "he";
      if (code === "en") return "en";
    }
    return "en";
  }

  let choice = "auto";
  try { choice = localStorage.getItem("pd-lang") || "auto"; } catch { /* приватный режим */ }
  const lang = NAMES[choice] ? choice : detect();
  const words = lang === "ru" ? null : WORDS[lang] || null;

  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === "he" ? "rtl" : "ltr";
  document.cookie = `pd_lang=${lang}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;

  function tx(ru, ...args) {
    const text = (words && words[ru]) || ru;
    return args.length ? text.replace(/\{(\d+)\}/g, (_, i) => (args[i] ?? "")) : text;
  }

  // Перевод готового HTML: текстовые узлы и подписи (placeholder, title, aria-label, alt).
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  function translateTree(node) {
    if (!words || !node) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) {
      const raw = t.nodeValue;
      const key = raw.trim();
      if (key && words[key]) t.nodeValue = raw.replace(key, () => words[key]);
    }
    for (const el of node.querySelectorAll ? node.querySelectorAll("[placeholder],[title],[aria-label],[alt]") : []) {
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && words[v.trim()]) el.setAttribute(a, words[v.trim()]);
      }
    }
  }

  // Окно выбора языка (кнопки с атрибутом data-lang-pick есть в меню каждой страницы).
  function pick() {
    const close = () => back.remove();
    const option = (code, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lang-opt" + (choice === code ? " on" : "");
      b.textContent = label;
      if (code !== "auto") b.lang = code;
      b.addEventListener("click", () => {
        try { localStorage.setItem("pd-lang", code); } catch { /* приватный режим */ }
        location.reload();
      });
      return b;
    };
    const back = document.createElement("div");
    back.className = "lang-back";
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    const box = document.createElement("div");
    box.className = "lang-box";
    box.setAttribute("role", "dialog");
    const h = document.createElement("h2");
    h.textContent = tx("🌐 Язык");
    box.append(h, option("auto", tx("Как на устройстве") + ` (${NAMES[detect()]})`),
      option("ru", NAMES.ru), option("en", NAMES.en), option("he", NAMES.he));
    back.append(box);
    document.body.append(back);
  }

  function bindPickers() {
    for (const b of document.querySelectorAll("[data-lang-pick]")) {
      b.textContent = `${tx("🌐 Язык")}: ${NAMES[lang]}`;
      b.addEventListener("click", pick);
    }
  }

  window.tx = tx;
  window.PDI18N = { lang, choice, locale: LOCALES[lang], rtl: lang === "he", names: NAMES, translateTree, pick };
  translateTree(document.body);
  if (words && words[document.title]) document.title = words[document.title];
  bindPickers();
})();
