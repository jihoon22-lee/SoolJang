/* 가격 알림 event ID만 보관한다. 제품명·가격·사용자/구독 키를 SW 저장소에 넣지 않는다. */
const PRICE_PUSH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claimPriceEvent(eventId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sooljang-price-push", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "id" });
    request.onerror = () => reject(new Error("push-dedup-unavailable"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("events", "readwrite");
      const store = transaction.objectStore("events");
      let claimed = false;
      const read = store.get(eventId);
      read.onsuccess = () => {
        if (read.result) return;
        store.add({ id: eventId, at: Date.now() });
        claimed = true;
        const all = store.getAll();
        all.onsuccess = () => {
          const ordered = all.result.sort((a, b) => b.at - a.at);
          for (const [index, entry] of ordered.entries()) {
            if (index >= 500 || entry.at < Date.now() - 30 * 86400000) store.delete(entry.id);
          }
        };
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(claimed);
      };
      transaction.onerror = transaction.onabort = () => {
        database.close();
        reject(new Error("push-dedup-unavailable"));
      };
    };
  });
}

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || typeof payload.event_id !== "string" || !PRICE_PUSH_UUID.test(payload.event_id))
    return;
  event.waitUntil(
    (async () => {
      if (!(await claimPriceEvent(payload.event_id))) return;
      await self.registration.showNotification("술장 가격 알림", {
        body: "목표가 조건이 확인되었습니다. 앱에서 관측 시각과 판매 조건을 확인하세요.",
        tag: `sooljang-price-${payload.event_id}`,
        renotify: false,
        icon: "/icons/icon-192.png",
        data: { event_id: payload.event_id },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  const eventId = event.notification.data?.event_id;
  if (typeof eventId !== "string" || !PRICE_PUSH_UUID.test(eventId)) return;
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL("/#price-watch", self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const current = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (current) {
        await current.navigate(url);
        await current.focus();
      } else await self.clients.openWindow(url);
    })(),
  );
});
