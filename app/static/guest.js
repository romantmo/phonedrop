// PhoneDrop — страница /get для собеседника: ввести код приглашения → попасть в чат.
// Здесь же список чатов, в которые этот браузер уже входил, — чтобы легко вернуться.
"use strict";

(() => {
  const { $, el, toast } = PD;

  async function call(path, options = {}) {
    const response = await fetch(path, Object.assign({ credentials: "same-origin" }, options));
    let data = null;
    try { data = await response.json(); } catch { /* пусто */ }
    return { status: response.status, data };
  }

  // Красиво: 123 456 789
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
    if (status === 200 && data.room) location.href = `/room/${data.room}`;
    else toast((data && data.detail) || `Ошибка ${status}`, true);
  });

  async function loadRooms() {
    const { status, data } = await call("/api/guest/rooms");
    if (status !== 200 || !data.rooms.length) return;
    $("roomsList").replaceChildren(...data.rooms.map((r) => el("a", { class: "g-file g-room", href: `/room/${r.id}` },
      el("span", { class: "g-ext g-ava" }, (r.title.trim()[0] || "?").toUpperCase()),
      el("div", { class: "g-info" }, el("b", {}, r.title),
        el("small", {}, r.last ? (r.last.sender === "guest" ? "Вы: " : "") + r.last.preview : "напиши первым")),
      r.unread ? el("span", { class: "g-badge" }, String(r.unread)) : null)));
    $("roomsCard").hidden = false;
  }

  $("codeCard").hidden = false;
  loadRooms();
})();
