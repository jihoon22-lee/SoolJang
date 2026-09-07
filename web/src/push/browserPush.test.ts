import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBrowserPush, enableBrowserPush } from "@/push/browserPush";
import { stubRoutes } from "@/testing";

const publicKey = btoa("synthetic public key");
function setup(permission: NotificationPermission = "granted") {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const current = {
    endpoint: "https://fcm.googleapis.com/fcm/send/synthetic",
    expirationTime: null,
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/synthetic",
      keys: { p256dh: "synthetic-receiver", auth: "synthetic-auth" },
    }),
    unsubscribe,
  };
  const subscribe = vi.fn().mockResolvedValue(current);
  const getSubscription = vi.fn().mockResolvedValue(null);
  const requestPermission = vi.fn().mockResolvedValue(permission);
  vi.stubGlobal("Notification", { requestPermission, permission });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("navigator", {
    serviceWorker: {
      getRegistration: vi
        .fn()
        .mockResolvedValue({ active: {}, pushManager: { subscribe, getSubscription } }),
    },
  });
  return { subscribe, getSubscription, requestPermission, current, unsubscribe };
}
afterEach(() => vi.unstubAllGlobals());
describe("명시 브라우저 푸시 구독", () => {
  it("권한 거절이면 구독·서버 요청을 하지 않는다", async () => {
    const browser = setup("denied");
    const { calls } = stubRoutes([]);
    await expect(enableBrowserPush(publicKey)).rejects.toThrow("허용되지 않았습니다");
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
  it("권한 동의 뒤 구독을 서버에 등록하고 폼 저장소는 사용하지 않는다", async () => {
    const browser = setup();
    const { calls } = stubRoutes([
      {
        match: "/price-watch/subscriptions",
        method: "POST",
        status: 201,
        body: { id: "subscription-one" },
      },
    ]);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await enableBrowserPush(publicKey);
    expect(browser.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(calls[0]?.body).toMatchObject({
      endpoint: browser.current.endpoint,
      keys: { p256dh: "synthetic-receiver", auth: "synthetic-auth" },
    });
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it("등록 실패는 새 브라우저 구독을 해제한다", async () => {
    const browser = setup();
    stubRoutes([{ match: "/price-watch/subscriptions", method: "POST", status: 503, body: {} }]);
    await expect(enableBrowserPush(publicKey)).rejects.toThrow();
    expect(browser.unsubscribe).toHaveBeenCalled();
  });
  it("로그아웃 경계는 현재 브라우저 구독만 해제한다", async () => {
    const browser = setup();
    browser.getSubscription.mockResolvedValue(browser.current);
    await clearBrowserPush();
    expect(browser.unsubscribe).toHaveBeenCalled();
  });
});

it("VAPID 키가 달라지면 기존 구독을 새 키로 다시 만든다", async () => {
  const browser = setup();
  browser.getSubscription.mockResolvedValue({
    ...browser.current,
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
  });
  stubRoutes([
    {
      match: "/price-watch/subscriptions",
      method: "POST",
      status: 201,
      body: { id: "updated-subscription" },
    },
  ]);
  await enableBrowserPush(publicKey);
  expect(browser.unsubscribe).toHaveBeenCalledTimes(1);
  expect(browser.subscribe).toHaveBeenCalledTimes(1);
});
