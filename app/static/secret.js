// PhoneDrop — открытие одноразовой ссылки (v2.3).
// Ключ живёт в части ссылки после «#»: браузер не отправляет её на сервер. Сервер отдаёт только
// шифровку и сразу стирает её. Расшифровка — здесь, в браузере (AES-256-GCM).
// Страница сама ничего не открывает: только по кнопке. Так «превью ссылок» в мессенджерах не сжигают её.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const id = location.pathname.split("/").pop();
  const key = location.hash.slice(1);
  // Убираем ключ из адресной строки: он не останется в истории браузера на этой странице.
  if (key) history.replaceState(null, "", location.pathname);

  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const info = (text, bad) => { $("secretInfo").textContent = text; $("secretInfo").classList.toggle("sys-error", !!bad); };

  async function decrypt(iv, ct) {
    const k = await crypto.subtle.importKey("raw", fromB64u(key), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(iv) }, k, fromB64u(ct));
    return new TextDecoder().decode(plain);
  }

  async function check() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return info(tx("Ссылка неполная: скопируй её целиком, вместе с частью после «#»."), true);
    if (!crypto.subtle) return info(tx("Шифрование работает только по https"), true);
    const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/status`, { credentials: "omit" });
    if (!r.ok) return info(tx("Ссылку уже открыли или срок её действия закончился"), true);
    info(tx("Тебе передали секретный текст. Его можно посмотреть только один раз — после этого ссылка перестанет работать."));
    $("secretOpen").hidden = false;
  }

  $("secretOpen").addEventListener("click", async () => {
    $("secretOpen").disabled = true;
    try {
      const r = await fetch(`/api/secrets/${encodeURIComponent(id)}/open`, { method: "POST", credentials: "omit" });
      if (!r.ok) {
        $("secretOpen").hidden = true;
        return info(tx("Ссылку уже открыли или срок её действия закончился"), true);
      }
      const data = await r.json();
      const text = await decrypt(data.iv, data.ct);
      $("secretOpen").hidden = true;
      $("secretText").textContent = text;
      $("secretText").hidden = false;
      $("secretCopy").hidden = false;
      info(tx("Сохрани текст сейчас — ссылка больше не откроется."));
    } catch {
      $("secretOpen").hidden = true;
      info(tx("Не получилось расшифровать: ссылка повреждена."), true);
    }
  });

  $("secretCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("secretText").textContent);
      $("secretCopy").textContent = tx("✅ Скопировано");
    } catch {
      getSelection().selectAllChildren($("secretText"));
    }
  });

  check().catch(() => info(tx("Нет связи с сервером. Попробуй ещё раз."), true));
})();
