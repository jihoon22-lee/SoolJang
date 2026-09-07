import { priceWatchApi } from "@/api/priceWatch";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator
  );
}

async function registration(): Promise<ServiceWorkerRegistration> {
  if (!pushSupported()) throw new Error("이 브라우저에서는 웹 푸시를 사용할 수 없습니다.");
  const active = await navigator.serviceWorker.getRegistration();
  if (!active?.active) throw new Error("앱 설치 또는 새로고침 후 다시 시도하세요.");
  return active;
}

export async function endpointFingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function currentPushFingerprint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const worker = await navigator.serviceWorker.getRegistration();
  const current = await worker?.pushManager.getSubscription();
  return current ? endpointFingerprint(current.endpoint) : null;
}

export async function enableBrowserPush(publicKey: string) {
  const worker = await registration();
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("알림 권한이 허용되지 않았습니다. 브라우저 설정에서 확인하세요.");
  const key = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const applicationServerKey = Uint8Array.from(
    atob(key + "=".repeat((4 - (key.length % 4)) % 4)),
    (char) => char.charCodeAt(0),
  );
  let subscription = await worker.pushManager.getSubscription();
  let created = false;
  try {
    if (subscription) {
      const previous = subscription.options?.applicationServerKey;
      const bytes = previous ? new Uint8Array(previous) : null;
      if (
        !bytes ||
        bytes.length !== applicationServerKey.length ||
        bytes.some((value, index) => value !== applicationServerKey[index])
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    if (!subscription) {
      subscription = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      created = true;
    }
    const data = subscription.toJSON();
    if (!data.endpoint || !data.keys?.p256dh || !data.keys?.auth)
      throw new Error("브라우저 구독 정보를 확인할 수 없습니다.");
    return await priceWatchApi.subscribe({
      endpoint: data.endpoint,
      keys: { p256dh: data.keys.p256dh, auth: data.keys.auth },
      expires_at: subscription.expirationTime
        ? new Date(subscription.expirationTime).toISOString()
        : null,
    });
  } catch (error) {
    if (created) await subscription?.unsubscribe();
    throw error;
  }
}

/** 로그아웃 시 브라우저 구독을 종료한다. 다른 기기의 구독과 서버의 개인 기록은 건드리지 않는다. */
export async function clearBrowserPush(): Promise<void> {
  if (!pushSupported()) return;
  const worker = await navigator.serviceWorker.getRegistration();
  const current = await worker?.pushManager.getSubscription();
  if (current) await current.unsubscribe();
}
