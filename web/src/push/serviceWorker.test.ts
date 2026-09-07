import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      handlers.set(type, handler),
    registration: { showNotification },
    location: { origin: "https://sooljang.example" },
    clients: {
      matchAll: vi.fn().mockResolvedValue([{ url: "https://sooljang.example/", navigate, focus }]),
      openWindow,
    },
  };
  runInNewContext(readFileSync("public/price-push.js", "utf8"), {
    self,
    indexedDB: new IDBFactory(),
    URL,
    Date,
    Promise,
  });
  async function push(data: unknown) {
    const pending: Promise<unknown>[] = [];
    handlers.get("push")?.({
      data: { json: () => data },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
  }
  return { handlers, push, showNotification, navigate, focus, openWindow };
}
const eventId = "11111111-1111-4111-8111-111111111111";
describe("가격 푸시 service worker", () => {
  it("같은 논리 이벤트를 동시에 받아도 한 번만 표시한다", async () => {
    const context = worker();
    await Promise.all([context.push({ event_id: eventId }), context.push({ event_id: eventId })]);
    await context.push({ event_id: eventId });
    expect(context.showNotification).toHaveBeenCalledTimes(1);
    expect(context.showNotification).toHaveBeenCalledWith(
      "술장 가격 알림",
      expect.objectContaining({
        tag: `sooljang-price-${eventId}`,
        renotify: false,
        data: { event_id: eventId },
      }),
    );
  });
  it("외부 제품명·주소를 표시하거나 잘못된 이벤트를 처리하지 않는다", async () => {
    const context = worker();
    await context.push({ event_id: "not-an-id", title: "private" });
    expect(context.showNotification).not.toHaveBeenCalled();
    await context.push({
      event_id: eventId,
      title: "private product",
      url: "https://attacker.example",
    });
    expect(JSON.stringify(context.showNotification.mock.calls)).not.toContain("private product");
    expect(JSON.stringify(context.showNotification.mock.calls)).not.toContain("attacker");
  });
  it("알림을 눌러도 같은 앱의 가격 감시 화면만 연다", async () => {
    const context = worker();
    const pending: Promise<unknown>[] = [];
    const close = vi.fn();
    context.handlers.get("notificationclick")?.({
      notification: { data: { event_id: eventId, url: "https://attacker.example" }, close },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
    expect(close).toHaveBeenCalled();
    expect(context.navigate).toHaveBeenCalledWith("https://sooljang.example/#price-watch");
    expect(context.focus).toHaveBeenCalled();
    expect(context.openWindow).not.toHaveBeenCalled();
  });
});
