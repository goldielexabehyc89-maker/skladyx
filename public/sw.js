// Service worker: нужен для установки PWA и web-push уведомлений.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ВАЖНО: fetch-обработчика здесь нет намеренно. Пустой обработчик заставляет
// браузер (особенно iOS) будить service worker на КАЖДЫЙ сетевой запрос —
// это заметно замедляет холодный старт PWA. Для установки и push он не нужен.

// Показ push-уведомления.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Склад", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Склад";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/warehouse" },
    tag: data.tag,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Клик по уведомлению — открыть/сфокусировать приложение на нужном экране.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/warehouse";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
