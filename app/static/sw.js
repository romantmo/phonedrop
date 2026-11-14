// Service worker PhoneDrop.
// 1) Нужен, чтобы телефон считал сайт устанавливаемым приложением.
// 2) Показывает push-уведомления, когда приложение закрыто.
// Ничего не кэширует — данные всегда идут напрямую на сервер.

// Safari (iPhone, iPad, Mac): там push обязан всегда показывать уведомление.
const APPLE = /AppleWebKit/.test(self.navigator.userAgent) && !/Chrome|Chromium|CriOS|Android|Edg/.test(self.navigator.userAgent);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  // POST (отправка файлов, «Поделиться») не трогаем — браузер обработает сам.
  if (event.request.method !== "GET" || event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          "<meta name=viewport content='width=device-width'><p style='font:17px system-ui;padding:24px'>Нет интернета. PhoneDrop работает только онлайн.</p>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        )
    )
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const show = (extra = {}) =>
    self.registration.showNotification(data.title || "PhoneDrop", {
      body: data.body || "Новое сообщение",
      tag: data.tag || "phonedrop",
      renotify: true,  // новое сообщение в том же чате снова звенит, а не тихо заменяет старое
      timestamp: Date.now(),
      icon: "/static/icons/icon-192.png",
      badge: "/static/icons/badge-96.png",
      data: { url: data.url || "/" },
      ...extra,
    });
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.filter((w) => w.visibilityState === "visible" && w.focused !== false);
      if (!open.length) return show();
      // PhoneDrop открыт на экране — пусть само приложение покажет баннер и сыграет звук.
      for (const w of open) w.postMessage({ type: "pd-push", data: { ...data, system: APPLE } });
      // iPhone/Safari отключает подписку, если push не показал уведомление (3 раза — и всё).
      // Поэтому там показываем его всегда, но без звука — звук играет приложение.
      if (APPLE) await show({ silent: true });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Уже открытая вкладка нужной страницы — просто переключаемся на неё.
      const existing = windows.find((w) => new URL(w.url).pathname === target.pathname);
      if (existing) {
        await existing.focus();
        if (target.search) existing.navigate(target.href).catch(() => {});
        return;
      }
      await self.clients.openWindow(target.href);
    })()
  );
});
