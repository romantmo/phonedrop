// PhoneDrop — «🧰 Для сисадмина» (v2.3): проверки сети с сервера и полезные утилиты.
//
// Что где выполняется (для чайника):
// - DNS, SSL, порты, IP и WHOIS проверяет НАШ сервер — это «взгляд из интернета», как видит клиент снаружи.
// - Пароли, калькулятор подсетей и разбор заголовков письма работают прямо в браузере: ничего не уходит на сервер.
// - Одноразовая ссылка шифруется в браузере; ключ — в ссылке после «#», сервер его не видит.
// Текст из ответов вставляется только через textContent (никакого innerHTML).
"use strict";

window.PDSysTools = (() => {
  const { el, toast, api, copyText } = PD;
  const ROLE = document.body.dataset.role || "phone";
  const post = (path, body) => api(ROLE, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // ---------- общие кусочки интерфейса
  const ICON = { ok: "✅", warn: "⚠️", bad: "❌", info: "ℹ️" };

  function input(attrs) {
    return el("input", Object.assign({ class: "opt-input", autocomplete: "off", autocapitalize: "off",
      spellcheck: "false", dir: "ltr" }, attrs));
  }

  function labeled(label, node) {
    return el("label", { class: "sys-field" }, el("span", { class: "opt-label" }, label), node);
  }

  function seg(choices, value, onChange) {
    const box = el("div", { class: "seg" });
    const draw = () => box.replaceChildren(...choices.map(([v, label]) =>
      el("button", { type: "button", class: v === value ? "on" : "", onclick: () => { value = v; draw(); onChange(v); } }, label)));
    draw();
    return box;
  }

  function checks(list) {
    return el("ul", { class: "sys-checks" }, ...list.map((c) =>
      el("li", { class: "sys-" + c.status }, el("span", { class: "sys-ico" }, ICON[c.status] || "•"), el("span", {}, c.text))));
  }

  function kv(rows) {
    return el("dl", { class: "sys-kv" }, ...rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== "")
      .flatMap(([k, v]) => [el("dt", {}, k), el("dd", { dir: "auto" }, String(v))]));
  }

  function copyRow(text, label) {
    return el("button", { type: "button", class: "sys-copy", dir: "ltr", title: tx("Скопировать"),
      onclick: () => copyText(text) }, label || text);
  }

  // Форма «ввести → нажать → результат»: общий порядок для всех сетевых проверок.
  function form(box, { fields, button, run, auto }) {
    const out = el("div", { class: "sys-out", "aria-live": "polite" });
    const btn = el("button", { class: "btn primary block", type: "button" }, button);
    let busy = false;
    async function go() {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      out.replaceChildren(el("p", { class: "sys-wait" }, tx("Проверяю…")));
      try {
        out.replaceChildren(...[].concat(await run()));
      } catch (e) {
        out.replaceChildren(el("p", { class: "sys-error" }, e.message));
      } finally {
        busy = false;
        btn.disabled = false;
      }
    }
    btn.addEventListener("click", go);
    for (const f of fields) {
      const inp = f.tagName === "INPUT" ? f : f.querySelector("input");
      if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    }
    box.replaceChildren(el("div", { class: "sys-form" }, ...fields, btn), out);
    if (auto) go();
    return go;
  }

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString(PDI18N.locale, { day: "numeric", month: "long", year: "numeric" });
  };

  // ================================================================ DNS и почта
  function renderDns(box) {
    const host = input({ placeholder: "example.com", inputmode: "url" });
    form(box, {
      fields: [labeled(tx("Домен"), host)],
      button: tx("Проверить домен"),
      run: async () => {
        const r = await post("/api/net/dns", { host: host.value });
        const order = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "DMARC", "DKIM", "Autodiscover", "CAA", "SOA"];
        const recs = order.filter((t) => r.records[t] && r.records[t].length).map((t) =>
          el("div", { class: "sys-rec" }, el("b", {}, t),
            ...r.records[t].map((v) => copyRow(v))));
        return [el("h3", { dir: "ltr" }, r.domain), checks(r.checks),
          el("h4", {}, tx("Записи DNS")), el("div", { class: "sys-recs" }, ...recs)];
      },
    });
  }

  // ================================================================ SSL
  function renderSsl(box) {
    const host = input({ placeholder: "mail.example.com", inputmode: "url" });
    const port = input({ placeholder: "443", inputmode: "numeric", maxlength: "5", class: "opt-input sys-port" });
    form(box, {
      fields: [el("div", { class: "sys-pair" }, labeled(tx("Сайт или сервер"), host), labeled(tx("Порт"), port))],
      button: tx("Проверить сертификат"),
      run: async () => {
        const r = await post("/api/net/ssl", { host: host.value, port: port.value || 443 });
        const http = r.http || {};
        return [el("h3", { dir: "ltr" }, `${r.host}:${r.port}`), checks(r.checks), kv([
          [tx("Выдан на"), r.subject],
          [tx("Кем выдан"), r.issuer],
          [tx("Действует до"), `${fmtDate(r.not_after)} (${tx("{0} дн.", r.days_left)})`],
          [tx("Имена в сертификате"), r.names.join(", ")],
          [tx("Протокол"), r.tls],
          [tx("IP-адрес"), r.ip],
          [tx("Ответ сайта"), http.status ? `HTTP ${http.status}${http.server ? " · " + http.server : ""}` : null],
          [tx("Перенаправляет на"), http.location],
        ])];
      },
    });
  }

  // ================================================================ порты
  const PORT_PRESETS = [
    ["RDP", "3389"], ["SSH", "22"], ["HTTPS", "443"], ["HTTP", "80"], ["SMTP", "25, 587"],
    ["IMAP/POP", "993, 995"], ["FTP", "21"], ["SQL", "1433"], ["VPN", "1194, 1723, 443"], ["SMB", "445"],
  ];
  const STATE = {
    open: ["ok", tx("открыт")],
    closed: ["bad", tx("закрыт")],
    filtered: ["warn", tx("нет ответа (фильтруется)")],
  };

  function renderPorts(box) {
    const host = input({ placeholder: tx("IP или имя сервера"), inputmode: "url" });
    const ports = input({ placeholder: "3389, 443", inputmode: "numeric" });
    const chips = el("div", { class: "sys-chips" }, ...PORT_PRESETS.map(([name, p]) =>
      el("button", { type: "button", class: "chip", onclick: () => { ports.value = p; } }, name)));
    form(box, {
      fields: [labeled(tx("Куда"), host), labeled(tx("Порты (до 10, через запятую)"), ports), chips],
      button: tx("Проверить порты"),
      run: async () => {
        const r = await post("/api/net/ports", { host: host.value, ports: ports.value });
        return [el("h3", { dir: "ltr" }, r.host === r.ip ? r.ip : `${r.host} · ${r.ip}`),
          checks(r.ports.map((p) => ({ status: STATE[p.state][0],
            text: `${p.port} — ${STATE[p.state][1]}${p.ms !== undefined ? ` · ${p.ms} ms` : ""}` }))),
          el("p", { class: "tool-note" }, tx("«Нет ответа» обычно значит, что порт закрыт файрволом и пакеты просто отбрасываются."))];
      },
    });
  }

  // ================================================================ мой IP и WHOIS
  function whoisRows(w) {
    if (!w) return [];
    if (w.kind === "domain") {
      return [[tx("Регистратор"), w.registrar], [tx("Зарегистрирован"), fmtDate(w.registered)],
        [tx("Оплачен до"), w.expires ? `${fmtDate(w.expires)}${w.days_left !== undefined ? ` (${tx("{0} дн.", w.days_left)})` : ""}` : null],
        [tx("Серверы имён (NS)"), (w.nameservers || []).join(", ")], [tx("Статус"), (w.status || []).join(", ")]];
    }
    return [[tx("Сеть"), w.network], [tx("Организация"), w.org], [tx("Диапазон"), w.range],
      [tx("Страна"), w.country], [tx("Жалобы (abuse)"), w.abuse]];
  }

  function renderMyIp(box) {
    const me = el("div", { class: "sys-out" }, el("p", { class: "sys-wait" }, tx("Проверяю…")));
    const q = input({ placeholder: tx("домен или IP"), inputmode: "url" });
    const whois = el("div");
    box.replaceChildren(el("h4", {}, tx("Мой внешний IP")), me, el("h4", {}, "WHOIS"), whois);
    form(whois, {
      fields: [q],
      button: tx("Найти владельца"),
      run: async () => {
        const w = await post("/api/net/whois", { query: q.value });
        const warn = w.days_left !== undefined && w.days_left < 30
          ? checks([{ status: "warn", text: tx("Домен скоро закончится — продли его") }]) : null;
        return [el("h3", { dir: "ltr" }, w.query), warn, kv(whoisRows(w))].filter(Boolean);
      },
    });
    api(ROLE, "/api/net/me").then((r) => {
      me.replaceChildren(copyRow(r.ip, `${r.ip}  📋`), kv([[tx("Обратное имя (PTR)"), r.ptr], ...whoisRows(r.whois)]),
        el("p", { class: "tool-note" }, tx("Это адрес, с которым это устройство выходит в интернет.")));
    }).catch((e) => me.replaceChildren(el("p", { class: "sys-error" }, e.message)));
  }

  // ================================================================ пароли
  const SETS = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{};:,.?/",
  };
  const AMBIGUOUS = /[Il1O0o|`'"]/g;

  function randomInt(max) {
    // Без «перекоса»: отбрасываем числа из неполного последнего круга.
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % max;
  }

  function makePassword(length, opts) {
    const sets = Object.keys(SETS).filter((k) => opts[k]).map((k) => opts.clear ? SETS[k].replace(AMBIGUOUS, "") : SETS[k]);
    if (!sets.length) return "";
    const all = sets.join("");
    for (;;) {  // в пароле должен быть хотя бы один символ каждого выбранного вида
      const pw = Array.from({ length }, () => all[randomInt(all.length)]).join("");
      if (length < sets.length || sets.every((s) => [...pw].some((ch) => s.includes(ch)))) return pw;
    }
  }

  function strength(length, opts) {
    const n = Object.keys(SETS).filter((k) => opts[k]).reduce((a, k) => a + (opts.clear ? SETS[k].replace(AMBIGUOUS, "") : SETS[k]).length, 0);
    const bits = Math.round(length * Math.log2(Math.max(n, 1)));
    const level = bits >= 100 ? ["ok", tx("очень надёжный")] : bits >= 70 ? ["ok", tx("надёжный")]
      : bits >= 50 ? ["warn", tx("средний")] : ["bad", tx("слабый")];
    return { status: level[0], text: tx("{0} бит — {1}", bits, level[1]) };
  }

  function renderPasswords(box) {
    const opts = { lower: true, upper: true, digits: true, symbols: true, clear: true };
    let length = 16;
    const out = el("div", { class: "sys-out" });
    const lenLabel = el("b", {});
    const range = el("input", { type: "range", min: "8", max: "64", value: String(length), class: "sys-range" });
    const toggle = (key, label) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = opts[key];
      cb.addEventListener("change", () => { opts[key] = cb.checked; draw(); });
      return el("label", { class: "sys-check" }, cb, label);
    };
    function draw() {
      lenLabel.textContent = tx("Длина: {0}", length);
      const list = Array.from({ length: 5 }, () => makePassword(length, opts)).filter(Boolean);
      out.replaceChildren(checks([strength(length, opts)]),
        ...list.map((pw) => copyRow(pw)),
        el("p", { class: "tool-note" }, tx("Пароли создаются прямо на этом устройстве и никуда не отправляются. Нажми на пароль, чтобы скопировать.")));
    }
    range.addEventListener("input", () => { length = +range.value; draw(); });
    box.replaceChildren(el("div", { class: "sys-form" }, lenLabel, range,
      el("div", { class: "sys-checks-row" }, toggle("upper", "A–Z"), toggle("lower", "a–z"), toggle("digits", "0–9"),
        toggle("symbols", "!@#"), toggle("clear", tx("без похожих (l, 1, O, 0)"))),
      el("button", { class: "btn block", type: "button", onclick: draw }, tx("🎲 Ещё варианты"))), out);
    draw();
  }

  // ================================================================ QR для Wi-Fi
  function renderWifi(box) {
    const ssid = input({ placeholder: tx("Название сети"), maxlength: "64" });
    const pass = input({ placeholder: tx("Пароль Wi-Fi"), maxlength: "128" });
    let security = "WPA";
    const hidden = el("input", { type: "checkbox" });
    const passField = labeled(tx("Пароль"), pass);
    const secSeg = seg([["WPA", "WPA/WPA2/WPA3"], ["WEP", "WEP"], ["nopass", tx("Без пароля")]], security, (v) => {
      security = v;
      passField.hidden = v === "nopass";
    });
    const gen = el("button", { type: "button", class: "chip", onclick: () => {
      pass.value = makePassword(16, { lower: true, upper: true, digits: true, symbols: false, clear: true });
    } }, tx("🎲 Придумать пароль"));
    form(box, {
      fields: [labeled(tx("Сеть (SSID)"), ssid), secSeg, passField, gen,
        el("label", { class: "sys-check" }, hidden, tx("Скрытая сеть"))],
      button: tx("Сделать QR-код"),
      run: async () => {
        const r = await post("/api/net/wifi-qr", { ssid: ssid.value, password: pass.value, security, hidden: hidden.checked });
        const src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(r.svg)));
        const card = el("div", { class: "wifi-card" },
          el("div", { class: "wifi-title" }, "📶 Wi-Fi"),
          el("img", { src, alt: "QR", class: "wifi-qr" }),
          el("div", { class: "wifi-name", dir: "auto" }, ssid.value),
          security !== "nopass" ? el("div", { class: "wifi-pass", dir: "ltr" }, pass.value) : null,
          el("div", { class: "wifi-hint" }, tx("Наведи камеру телефона на код, чтобы подключиться")));
        const print = () => {
          document.body.classList.add("print-wifi");
          card.classList.add("printing");
          window.print();
          setTimeout(() => { document.body.classList.remove("print-wifi"); card.classList.remove("printing"); }, 500);
        };
        const download = el("a", { class: "btn", href: src, download: `wifi-${ssid.value.replace(/[^\w-]+/g, "_") || "qr"}.svg` },
          tx("⬇️ Скачать"));
        return [card, el("div", { class: "tool-results-actions" },
          el("button", { class: "btn primary", type: "button", onclick: print }, tx("🖨 Распечатать")), download),
          el("p", { class: "tool-note" }, tx("Пароль нигде не сохраняется: сервер только рисует картинку."))];
      },
    });
  }

  // ================================================================ подсети
  const ipToInt = (s) => {
    const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s);
    if (!m || m.slice(1).some((x) => +x > 255)) return null;
    return m.slice(1).reduce((a, x) => a * 256 + +x, 0);
  };
  const intToIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
  const maskOf = (p) => (p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0);

  function prefixOfMask(n) {
    for (let p = 0; p <= 32; p++) if (maskOf(p) === n) return p;
    return null;
  }

  function parseCidr(text) {
    const parts = text.trim().split(/[\s/]+/);
    const ip = ipToInt(parts[0] || "");
    if (ip === null) return null;
    let prefix = 32;
    if (parts[1] !== undefined) {
      prefix = /^\d{1,2}$/.test(parts[1]) ? +parts[1] : prefixOfMask(ipToInt(parts[1]) ?? -1);
      if (prefix === null || prefix > 32) return null;
    }
    return { ip, prefix };
  }

  function kindOf(n) {
    const inNet = (base, p) => (n & maskOf(p)) >>> 0 === ipToInt(base);
    if (inNet("10.0.0.0", 8) || inNet("172.16.0.0", 12) || inNet("192.168.0.0", 16)) return tx("частная (LAN)");
    if (inNet("100.64.0.0", 10)) return tx("CGNAT провайдера");
    if (inNet("127.0.0.0", 8)) return tx("loopback (этот же компьютер)");
    if (inNet("169.254.0.0", 16)) return tx("APIPA — DHCP не ответил");
    if (inNet("224.0.0.0", 4)) return "multicast";
    return tx("публичная (интернет)");
  }

  function subnetInfo(ip, prefix) {
    const mask = maskOf(prefix);
    const net = (ip & mask) >>> 0;
    const size = 2 ** (32 - prefix);
    const bcast = net + size - 1;
    const hosts = prefix >= 31 ? size : size - 2;
    return { mask, net, bcast, size, hosts,
      first: prefix >= 31 ? net : net + 1, last: prefix >= 31 ? bcast : bcast - 1 };
  }

  function renderSubnet(box) {
    const cidr = input({ placeholder: "192.168.1.10/24", value: "192.168.1.0/24" });
    const out = el("div", { class: "sys-out" });
    const splitBox = el("div");
    const test = input({ placeholder: tx("Проверить IP: 192.168.1.77") });
    const testOut = el("div");
    let cur = null;

    function draw() {
      const p = parseCidr(cidr.value);
      if (!p) {
        cur = null;
        out.replaceChildren(el("p", { class: "sys-error" }, tx("Пример: 192.168.1.10/24 или 10.0.0.5 255.255.0.0")));
        splitBox.replaceChildren();
        return;
      }
      const s = subnetInfo(p.ip, p.prefix);
      cur = { ...p, ...s };
      out.replaceChildren(kv([
        [tx("Сеть"), `${intToIp(s.net)}/${p.prefix}`],
        [tx("Маска"), `${intToIp(s.mask)}  (/${p.prefix})`],
        [tx("Wildcard (для ACL)"), intToIp((~s.mask) >>> 0)],
        [tx("Первый адрес"), intToIp(s.first)],
        [tx("Последний адрес"), intToIp(s.last)],
        [tx("Широковещательный"), p.prefix >= 31 ? "—" : intToIp(s.bcast)],
        [tx("Адресов для устройств"), s.hosts.toLocaleString(PDI18N.locale)],
        [tx("Тип"), kindOf(s.net)],
      ]));
      drawSplit();
      drawTest();
    }

    function drawSplit() {
      if (!cur || cur.prefix >= 30) return splitBox.replaceChildren();
      const options = [];
      for (let np = cur.prefix + 1; np <= Math.min(cur.prefix + 8, 30); np++) options.push(np);
      const select = el("select", { class: "opt-input" }, ...options.map((np) =>
        el("option", { value: String(np) }, tx("на {0} подсетей по /{1} ({2} адресов)", 2 ** (np - cur.prefix), np, 2 ** (32 - np) - 2))));
      const list = el("div", { class: "sys-recs" });
      const fill = () => {
        const np = +select.value;
        const step = 2 ** (32 - np);
        const count = 2 ** (np - cur.prefix);
        const rows = [];
        for (let i = 0; i < Math.min(count, 64); i++) {
          const n = cur.net + i * step;
          rows.push(copyRow(`${intToIp(n)}/${np}   ${intToIp(n + 1)} – ${intToIp(n + step - 2)}`));
        }
        if (count > 64) rows.push(el("p", { class: "tool-note" }, tx("…и ещё {0}", count - 64)));
        list.replaceChildren(...rows);
      };
      select.addEventListener("change", fill);
      splitBox.replaceChildren(el("h4", {}, tx("Разделить сеть")), select, list);
      fill();
    }

    function drawTest() {
      const n = ipToInt(test.value);
      if (!cur || !test.value.trim()) return testOut.replaceChildren();
      if (n === null) return testOut.replaceChildren(checks([{ status: "bad", text: tx("Это не IPv4-адрес") }]));
      const inside = n >= cur.net && n <= cur.bcast;
      testOut.replaceChildren(checks([inside
        ? { status: "ok", text: tx("{0} входит в эту сеть", intToIp(n)) }
        : { status: "warn", text: tx("{0} — в другой сети: нужен маршрутизатор (шлюз)", intToIp(n)) }]));
    }

    cidr.addEventListener("input", draw);
    test.addEventListener("input", drawTest);
    box.replaceChildren(el("div", { class: "sys-form" }, labeled(tx("Адрес и маска"), cidr)), out, splitBox,
      el("h4", {}, tx("Тот же ли это сегмент?")), test, testOut);
    draw();
  }

  // ================================================================ заголовки письма
  function decodeWords(text) {
    // =?UTF-8?B?...?= и =?UTF-8?Q?...?= — так в заголовках пишут не-латинские темы и имена
    return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=\s*(?==\?)/g, "=?$1?$2?$3?=")
      .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, charset, enc, data) => {
        try {
          let bytes;
          if (enc.toUpperCase() === "B") bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          else {
            const s = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
            bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
          }
          return new TextDecoder(charset).decode(bytes);
        } catch { return all; }
      });
  }

  function parseHeaders(raw) {
    const head = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/)[0].replace(/\n[ \t]+/g, " ");
    const list = [];
    for (const line of head.split("\n")) {
      const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
      if (m) list.push([m[1].toLowerCase(), m[2].trim()]);
    }
    const all = (name) => list.filter(([k]) => k === name).map(([, v]) => v);
    const one = (name) => all(name)[0] || "";
    return { list, all, one };
  }

  const domainOf = (addr) => ((/@([^>\s;]+)/.exec(addr || "") || [])[1] || "").toLowerCase().replace(/[>"']/g, "");
  const baseDomain = (d) => d.split(".").slice(-2).join(".");

  function fmtDelay(sec) {
    if (sec === null || isNaN(sec)) return "";
    if (sec < 0) return tx("часы не совпадают");
    if (sec < 60) return tx("{0} с", sec);
    if (sec < 3600) return tx("{0} мин", Math.round(sec / 60));
    return tx("{0} ч", (sec / 3600).toFixed(1));
  }

  const SFV = {
    SPM: ["bad", tx("Microsoft 365: помечено как спам")],
    NSPM: ["ok", tx("Microsoft 365: не спам")],
    SKS: ["warn", tx("Microsoft 365: помечено как спам правилом")],
    BLK: ["warn", tx("Microsoft 365: отправитель в списке заблокированных")],
    SFE: ["info", tx("Microsoft 365: отправитель в списке надёжных")],
    SKN: ["info", tx("Microsoft 365: правило пропустило фильтр спама")],
    SKA: ["info", tx("Microsoft 365: пропущено списком разрешённых")],
    SKQ: ["warn", tx("Microsoft 365: письмо выпущено из карантина")],
  };

  function analyzeHeaders(raw) {
    const h = parseHeaders(raw);
    const out = [];
    const res = [];
    // Путь письма: Received читаются снизу вверх (первый сервер — последний в списке).
    const hops = h.all("received").reverse().map((v) => {
      const semi = v.lastIndexOf(";");
      const date = semi >= 0 ? Date.parse(v.slice(semi + 1).replace(/\([^)]*\)/g, "").trim()) : NaN;
      const from = (/\bfrom\s+(\S+)(?:\s+\(([^)]*)\))?/i.exec(v) || []);
      const by = (/\bby\s+(\S+)/i.exec(v) || [])[1] || "?";
      // Настоящий адрес — в скобках после имени («(unknown [198.51.100.9])»), а не то, чем сервер назвался.
      const IP = /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})/i;
      const ip = ((from[2] && IP.exec(from[2])) || IP.exec(v) || [])[1] || "";
      const name = (from[1] || "").replace(/^\[|\]$/g, "");
      return { from: name === ip ? "" : from[1] || "", by, ip, date };
    });
    const startDate = Date.parse((h.one("date") || "").replace(/\([^)]*\)/g, ""));
    let prev = isNaN(startDate) ? null : startDate;

    const auth = h.all("authentication-results").join(" ; ") + " ; " + h.all("arc-authentication-results").join(" ; ");
    const result = (name) => ((new RegExp(`\\b${name}=(\\w+)`, "i").exec(auth) || [])[1] || "").toLowerCase();
    const spfHeader = (/^(\w+)/.exec(h.one("received-spf")) || [])[1] || "";
    const spf = result("spf") || spfHeader.toLowerCase();
    const dkim = result("dkim");
    const dmarc = result("dmarc");
    const compauth = result("compauth");
    const tone = (v) => (v === "pass" ? "ok" : ["fail", "softfail", "permerror", "temperror"].includes(v) ? "bad" : "info");
    if (spf) res.push({ status: tone(spf), text: `SPF: ${spf}` });
    if (dkim) res.push({ status: tone(dkim), text: `DKIM: ${dkim}` });
    if (dmarc) res.push({ status: tone(dmarc), text: `DMARC: ${dmarc}` });
    if (compauth) res.push({ status: tone(compauth), text: `compauth: ${compauth}` });
    if (!spf && !dkim && !dmarc) res.push({ status: "info", text: tx("Нет результатов проверки SPF/DKIM/DMARC в заголовках") });

    const fromDomain = domainOf(h.one("from"));
    const rp = domainOf(h.one("return-path"));
    const reply = domainOf(h.one("reply-to"));
    if (reply && fromDomain && baseDomain(reply) !== baseDomain(fromDomain)) {
      res.push({ status: "warn", text: tx("Ответ уйдёт на другой домен: {0} (частый признак фишинга)", reply) });
    }
    if (rp && fromDomain && baseDomain(rp) !== baseDomain(fromDomain)) {
      res.push({ status: "info", text: tx("Технический отправитель (Return-Path) — {0}: так бывает у рассылок", rp) });
    }

    // Microsoft 365 / Exchange Online
    const forefront = h.one("x-forefront-antispam-report") || h.one("x-microsoft-antispam-mailbox-delivery");
    const tags = Object.fromEntries(forefront.split(";").map((p) => p.split(":").map((x) => x.trim())).filter((p) => p.length >= 2));
    const scl = h.one("x-ms-exchange-organization-scl") || tags.SCL;
    if (tags.SFV && SFV[tags.SFV]) res.push({ status: SFV[tags.SFV][0], text: SFV[tags.SFV][1] });
    if (scl !== undefined && scl !== "") {
      const n = +scl;
      res.push({ status: n >= 5 ? "bad" : n < 0 ? "info" : "ok",
        text: n >= 5 ? tx("SCL {0} — Microsoft считает письмо спамом", n) : n < 0 ? tx("SCL -1 — фильтр спама пропущен (доверенный отправитель)") : tx("SCL {0} — не спам", n) });
    }

    out.push(el("h4", {}, tx("Проверки")), checks(res));
    out.push(kv([
      [tx("От"), decodeWords(h.one("from"))],
      [tx("Кому"), decodeWords(h.one("to"))],
      [tx("Тема"), decodeWords(h.one("subject"))],
      [tx("Дата"), h.one("date")],
      ["Return-Path", h.one("return-path")],
      ["Reply-To", decodeWords(h.one("reply-to"))],
      ["Message-ID", h.one("message-id")],
      [tx("IP отправителя"), tags.CIP || h.one("x-originating-ip").replace(/[[\]]/g, "")],
      [tx("Страна отправителя"), tags.CTRY],
    ]));

    if (hops.length) {
      const total = !isNaN(hops[hops.length - 1].date) && prev !== null ? (hops[hops.length - 1].date - prev) / 1000 : null;
      out.push(el("h4", {}, tx("Путь письма — серверов: {0}", hops.length) + (total !== null ? ` · ${fmtDelay(Math.round(total))}` : "")));
      out.push(el("ol", { class: "sys-hops" }, ...hops.map((hop) => {
        const delay = !isNaN(hop.date) && prev !== null ? Math.round((hop.date - prev) / 1000) : null;
        if (!isNaN(hop.date)) prev = hop.date;
        const slow = delay !== null && delay > 300;
        return el("li", { class: slow ? "slow" : "" },
          el("div", { dir: "ltr" }, el("b", {}, hop.by), hop.from ? ` ← ${hop.from}` : "", hop.ip ? ` [${hop.ip}]` : ""),
          el("div", { class: "sys-hop-meta" },
            !isNaN(hop.date) ? new Date(hop.date).toLocaleString(PDI18N.locale) : "",
            delay !== null ? ` · +${fmtDelay(delay)}` : "", slow ? ` ⚠️ ${tx("задержка")}` : ""));
      })));
    } else {
      out.push(el("p", { class: "sys-error" }, tx("Не нашёл строк Received — вставь заголовки целиком")));
    }
    return out;
  }

  function renderHeaders(box) {
    const ta = el("textarea", { class: "opt-input sys-textarea", rows: "8", dir: "ltr", spellcheck: "false",
      placeholder: "Received: from …\nAuthentication-Results: …\nFrom: …" });
    const out = el("div", { class: "sys-out" });
    const go = () => {
      if (!ta.value.trim()) return toast(tx("Вставь заголовки письма"), true);
      out.replaceChildren(...analyzeHeaders(ta.value));
    };
    box.replaceChildren(el("div", { class: "sys-form" },
      el("p", { class: "tool-note" }, tx("Outlook: письмо → Файл → Свойства → «Заголовки Интернета». Gmail: ⋮ → «Показать оригинал». Разбор делается в браузере, письмо никуда не отправляется.")),
      ta, el("button", { class: "btn primary block", type: "button", onclick: go }, tx("Разобрать"))), out);
  }

  // ================================================================ одноразовая ссылка
  const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const TTL_CHOICES = [[3600, tx("1 час")], [86400, tx("1 день")], [604800, tx("7 дней")]];

  async function encrypt(text) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    return { key: b64u(raw), iv: b64u(iv), ct: b64u(ct) };
  }

  function renderSecret(box) {
    const text = el("textarea", { class: "opt-input sys-textarea", rows: "5", maxlength: "10000", dir: "auto",
      placeholder: tx("Пароль, ключ, данные для входа…"), autocomplete: "off", spellcheck: "false" });
    const label = input({ placeholder: tx("Для себя: о чём ссылка (видно только тебе)"), maxlength: "60", dir: "auto" });
    let ttl = 86400;
    const out = el("div", { class: "sys-out" });
    const mine = el("div");
    const btn = el("button", { class: "btn primary block", type: "button" }, tx("🔗 Создать ссылку"));

    async function loadMine() {
      try {
        const { items } = await api(ROLE, "/api/secrets");
        mine.replaceChildren(...(items.length ? [el("h4", {}, tx("Мои ссылки"))] : []), ...items.map((s) =>
          el("div", { class: "sys-secret" },
            el("span", { class: "sys-ico" }, s.opened ? "✅" : "⏳"),
            el("div", { class: "sys-secret-text" },
              el("b", { dir: "auto" }, s.label || tx("без названия")),
              el("span", {}, s.opened
                ? tx("открыта {0}", new Date(s.opened * 1000).toLocaleString(PDI18N.locale))
                : tx("ждёт до {0}", new Date(s.expires * 1000).toLocaleString(PDI18N.locale)))),
            el("button", { class: "icon-btn", type: "button", title: tx("Удалить"), "aria-label": tx("Удалить"),
              onclick: async () => { await api(ROLE, `/api/secrets/${s.id}`, { method: "DELETE" }); loadMine(); } }, "🗑"))));
      } catch { /* список — не главное */ }
    }

    btn.addEventListener("click", async () => {
      if (!text.value.trim()) return toast(tx("Напиши, что передать"), true);
      if (!crypto.subtle) return toast(tx("Шифрование работает только по https"), true);
      btn.disabled = true;
      try {
        const enc = await encrypt(text.value);
        const r = await post("/api/secrets", { iv: enc.iv, ct: enc.ct, ttl, label: label.value });
        const link = `${r.url}#${enc.key}`;
        text.value = "";
        const share = navigator.share ? el("button", { class: "btn", type: "button",
          onclick: () => navigator.share({ url: link }).catch(() => {}) }, tx("📤 Поделиться")) : null;
        out.replaceChildren(
          checks([{ status: "ok", text: tx("Ссылка готова. Её можно открыть только один раз.") }]),
          copyRow(link),
          el("div", { class: "tool-results-actions" },
            el("button", { class: "btn primary", type: "button", onclick: () => copyText(link) }, tx("📋 Скопировать")), share),
          el("p", { class: "tool-note" }, tx("Отправь ссылку в мессенджер или по почте. Когда её откроют, придёт уведомление. Ключ — в части ссылки после «#»: сервер его не знает и прочитать текст не может.")));
        loadMine();
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    box.replaceChildren(el("div", { class: "sys-form" }, text, label,
      el("div", { class: "opt-row" }, el("div", { class: "opt-label" }, tx("Ссылка работает")),
        seg(TTL_CHOICES, ttl, (v) => { ttl = v; })), btn), out, mine);
    loadMine();
  }

  // ================================================================ список
  const TOOLS = [
    { id: "dns", icon: "🌐", title: tx("DNS и почта домена"), sub: "MX · SPF · DKIM · DMARC",
      hint: tx("Проверка записей домена и настроек почты (в том числе Microsoft 365): почему письма уходят в спам или не доходят."),
      render: renderDns },
    { id: "ssl", icon: "🔐", title: tx("SSL-сертификат"), sub: tx("Срок, цепочка, имена"),
      hint: tx("Когда заканчивается сертификат сайта или почтового сервера и правильно ли он установлен."),
      render: renderSsl },
    { id: "ports", icon: "🚪", title: tx("Проверка портов"), sub: tx("Открыт ли RDP, VPN, SMTP…"),
      hint: tx("Проверка снаружи — с сервера PhoneDrop в интернете, как будто стучится чужой компьютер. Так видно, работает ли проброс портов на роутере."),
      render: renderPorts },
    { id: "myip", icon: "📍", title: tx("Мой IP и WHOIS"), sub: tx("Внешний адрес, владелец домена"),
      hint: tx("Твой внешний IP-адрес и кому принадлежит домен или IP: регистратор, срок оплаты, провайдер."),
      render: renderMyIp },
    { id: "secret", icon: "🔑", title: tx("Одноразовая ссылка"), sub: tx("Передать пароль безопасно"),
      hint: tx("Пароль не останется в переписке: ссылка открывается один раз и исчезает."),
      render: renderSecret },
    { id: "passgen", icon: "🎲", title: tx("Генератор паролей"), sub: tx("Надёжные, без похожих символов"),
      hint: tx("Случайные пароли для пользователей, Wi-Fi и сервисов."),
      render: renderPasswords },
    { id: "wifi", icon: "📶", title: tx("QR-код для Wi-Fi"), sub: tx("Подключение без ввода пароля"),
      hint: tx("Распечатай и повесь в офисе или переговорной: гости подключаются камерой телефона."),
      render: renderWifi },
    { id: "subnet", icon: "🧮", title: tx("Калькулятор подсетей"), sub: tx("Маска, диапазон, разделение"),
      hint: tx("Введи адрес с маской — увидишь сеть, диапазон адресов, wildcard для ACL и как разделить сеть."),
      render: renderSubnet },
    { id: "headers", icon: "✉️", title: tx("Заголовки письма"), sub: tx("Откуда пришло, спам или нет"),
      hint: tx("Путь письма по серверам с задержками, SPF/DKIM/DMARC и вердикт фильтра Microsoft 365."),
      render: renderHeaders },
  ].map((t) => Object.assign(t, { group: "admin" }));

  return { TOOLS, makePassword, parseCidr, subnetInfo, analyzeHeaders };
})();
