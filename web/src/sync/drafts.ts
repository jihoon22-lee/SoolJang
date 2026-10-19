/** 입력 중인 폼만 저장한다. 토큰·키·파일은 이 저장소로 받지 않는다. */
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { databaseIdentity } from "@/sync/db";

const PREFIX = "sooljang-draft-v1:";
/** 불러온 다른 탭 초안의 `updatedAt`. 원본 탭이 열려 있을 수 있어 원본 대신 이 표시를 남긴다. */
const RESTORED_PREFIX = "sooljang-draft-restored-v1:";
const TAB_KEY = "sooljang-draft-tab";
export const draftEvents = new EventTarget();
/** 새 탭은 복제된 sessionStorage ID를 재사용하지 않는다. reload는 같은 draft를 연다. */
export function initializeDraftTab(): void {
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (navigation?.type === "navigate" || !sessionStorage.getItem(TAB_KEY))
    sessionStorage.setItem(TAB_KEY, crypto.randomUUID());
  pruneStaleDrafts();
}
/** 30일 넘게 손대지 않은 다른 탭의 초안. PWA 를 다시 열 때마다 새 탭 키가 생겨 계속 쌓였다. */
export const STALE_DRAFT_MS = 30 * 24 * 60 * 60 * 1000;
export function pruneStaleDrafts(now = Date.now()): void {
  const current = sessionStorage.getItem(TAB_KEY);
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(RESTORED_PREFIX)) {
      if (localStorage.getItem(PREFIX + key.slice(RESTORED_PREFIX.length)) === null)
        localStorage.removeItem(key);
      continue;
    }
    if (!key.startsWith(PREFIX)) continue;
    if (current && key.includes(`:${current}:`)) continue;
    try {
      const at = Number(JSON.parse(localStorage.getItem(key) ?? "null")?.updatedAt);
      if (Number.isFinite(at) && now - at > STALE_DRAFT_MS) {
        localStorage.removeItem(key);
        localStorage.removeItem(RESTORED_PREFIX + key.slice(PREFIX.length));
      }
    } catch {
      /* 손상된 기록은 사용자가 확인할 수 있게 그대로 둔다. */
    }
  }
}
function decodeDraft<T>(value: unknown, fallback: T): T {
  if (value === null || typeof value !== typeof fallback || containsSecret(value)) return fallback;
  if (fallback !== null && typeof fallback === "object" && !Array.isArray(fallback)) {
    const candidate = value as Record<string, unknown>;
    const restored = { ...fallback };
    for (const key of Object.keys(fallback))
      if (typeof candidate[key] === typeof (fallback as Record<string, unknown>)[key])
        (restored as Record<string, unknown>)[key] = candidate[key];
    return restored;
  }
  return value as T;
}
function tabId(): string {
  let value = sessionStorage.getItem(TAB_KEY);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, value);
  }
  return value;
}
function storageKey(form: string, userId: string): string {
  return `${PREFIX}${encodeURIComponent(userId)}:${tabId()}:${form}`;
}
/** 같은 계정·탭의 이전 입력만 읽는다. 이전 저장 형식도 지우지 않고 이어 쓸 수 있다. */
export function readFormDraftValue<T>(form: string, fallback: T): T {
  const userId = databaseIdentity().userId;
  if (!userId) return fallback;
  try {
    const raw = localStorage.getItem(storageKey(form, userId));
    return raw ? decodeDraft(JSON.parse(raw)?.value, fallback) : fallback;
  } catch {
    return fallback;
  }
}
function containsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecret);
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, nested]) =>
        /password|secret|token|api.?key|credential/i.test(key) || containsSecret(nested),
    )
  );
}
export function clearFormDraft(form: string, userId = databaseIdentity().userId): void {
  if (!userId) return;
  const prefix = storageKey(form, userId);
  for (const key of Object.keys(localStorage))
    if (key === prefix || key.startsWith(`${prefix}:`)) localStorage.removeItem(key);
  draftEvents.dispatchEvent(new Event("saved"));
}
/** 제출한 탭·계정 세대와 초안 전체 버전을 보관한다. */
export function captureFormDraft(form: string) {
  const identity = databaseIdentity();
  const prefix = identity.userId ? storageKey(form, identity.userId) : null;
  const entries = prefix
    ? Object.keys(localStorage)
        .filter((key) => key === prefix || key.startsWith(`${prefix}:`))
        .sort()
        .map((key) => [key, localStorage.getItem(key)] as const)
    : [];
  return { identity, prefix, entries };
}

const REQUEST_PREFIX = "sooljang-request-v1:";
function requestKey(form: string, userId: string): string {
  // 복제한 탭은 sessionStorage 를 복사해 오지만 탭 id 는 새로 받는다. 탭 id 를 넣어 두 탭의
  // 같은 내용 등록이 한 요청으로 합쳐지지 않게 한다.
  return `${REQUEST_PREFIX}${encodeURIComponent(userId)}:${tabId()}:${form}`;
}

/**
 * 온라인 생성 요청의 멱등 식별자. 결과가 확정될 때까지(`finishSubmission`) 같은 값을 돌려준다.
 * 응답을 잃은 뒤 내용을 고쳐 다시 보내도 같은 키라, 앞선 요청이 저장됐으면 서버가 중복을 만들지
 * 않고 409로 알린다. 기본값만으로 제출해 초안이 저장되지 않은 폼도 같은 값을 쓴다. 이 탭·계정
 * 안에서만 유효하다.
 */
export function submissionRequestId(form: string): string {
  const userId = databaseIdentity().userId;
  if (!userId) return crypto.randomUUID();
  const key = requestKey(form, userId);
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
      requestId?: unknown;
    } | null;
    if (typeof stored?.requestId === "string") return stored.requestId;
  } catch {
    // 손상된 값은 새 요청으로 덮는다.
  }
  const requestId = crypto.randomUUID();
  try {
    sessionStorage.setItem(key, JSON.stringify({ requestId }));
  } catch {
    // 저장할 수 없으면 이번 요청만 멱등하다(재시도는 새 요청).
  }
  return requestId;
}

/**
 * 결과가 확정된 요청을 잊는다. 이후 같은 내용을 일부러 한 번 더 등록하면 새 기록이 된다.
 * `requestId` 를 주면 그 요청일 때만 지운다.
 */
export function finishSubmission(form: string, requestId?: string): void {
  const userId = databaseIdentity().userId;
  if (!userId) return;
  const key = requestKey(form, userId);
  try {
    if (
      requestId === undefined ||
      JSON.parse(sessionStorage.getItem(key) ?? "null")?.requestId === requestId
    )
      sessionStorage.removeItem(key);
  } catch {
    sessionStorage.removeItem(key);
  }
}

/**
 * 실패한 생성 요청 중 결과가 확정된 것만 잊는다. 409는 이 키로 이미 다른 내용이 저장됐다는
 * 답이다. 연결 실패·5xx는 물론 422·401도 앞선 시도가 저장됐는지 알려 주지 않으므로 키를 유지한다.
 */
export function settleFailedSubmission(form: string, requestId: string, status?: number): void {
  if (status === 409) finishSubmission(form, requestId);
}

/** 이전 저장의 성공으로 이후 입력이나 재로그인한 세션의 초안을 지우지 않는다. */
export function clearSubmittedDraft(snapshot: ReturnType<typeof captureFormDraft>): boolean {
  const current = databaseIdentity();
  if (
    !snapshot.prefix ||
    snapshot.identity.userId !== current.userId ||
    snapshot.identity.generation !== current.generation
  )
    return false;
  const keys = Object.keys(localStorage)
    .filter((key) => key === snapshot.prefix || key.startsWith(`${snapshot.prefix}:`))
    .sort();
  if (
    keys.length !== snapshot.entries.length ||
    snapshot.entries.some(
      ([key, value], index) => keys[index] !== key || localStorage.getItem(key) !== value,
    )
  )
    return false;
  for (const key of keys) localStorage.removeItem(key);
  draftEvents.dispatchEvent(new Event("saved"));
  return true;
}
/**
 * 이전 형식 이름(`isLegacy`)으로 저장된 이 계정의 초안을 `to` 로 옮긴다(탭마다). 폼 키를 바꾼 뒤에도
 * 업데이트 전에 쓰던 초안을 잃지 않게 한다. 새 이름에 이미 초안이 있는 탭은 그대로 둔다.
 */
export function migrateFormDrafts(isLegacy: (form: string) => boolean, to: string): void {
  const userId = databaseIdentity().userId;
  if (!userId) return;
  const prefix = `${PREFIX}${encodeURIComponent(userId)}:`;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const separator = suffix.indexOf(":");
    const form = suffix.slice(separator + 1);
    if (separator < 0 || form === to || !isLegacy(form)) continue;
    const target = `${prefix}${suffix.slice(0, separator)}:${to}`;
    try {
      const stored = localStorage.getItem(key);
      if (stored === null || localStorage.getItem(target) !== null) continue;
      localStorage.setItem(target, stored);
      localStorage.removeItem(key);
    } catch {
      /* 옮기지 못하면 원래 초안을 그대로 둔다. */
    }
  }
}
/** 다른 탭/이전 세션의 입력은 자동으로 덮어쓰지 않고 명시적으로 복원한다. */
export function recoverableDraft(form: string): string | null {
  const userId = databaseIdentity().userId;
  if (!userId) return null;
  const prefix = `${PREFIX}${encodeURIComponent(userId)}:`;
  let latest: { tab: string; at: number } | null = null;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const separator = suffix.indexOf(":");
    const tab = suffix.slice(0, separator);
    const kind = suffix.slice(separator + 1);
    if (tab === tabId() || !(kind === form || kind.startsWith(`${form}:`))) continue;
    try {
      const at = Number(JSON.parse(localStorage.getItem(key) ?? "null")?.updatedAt);
      const restored = localStorage.getItem(RESTORED_PREFIX + key.slice(PREFIX.length));
      if (restored !== null && Number(restored) === at) continue;
      if (Number.isFinite(at) && (!latest || at > latest.at)) latest = { tab, at };
    } catch {
      /* Damaged records remain untouched. */
    }
  }
  return latest?.tab ?? null;
}
export function restoreFormDraft(form: string, sourceTab: string): void {
  draftEvents.dispatchEvent(
    new CustomEvent("restore", { detail: { form, sourceTab, userId: databaseIdentity().userId } }),
  );
}
export function useDraftState<T>(
  form: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>, Dispatch<SetStateAction<T>>] {
  const [identity] = useState(databaseIdentity);
  const [key] = useState(() => (identity.userId ? storageKey(form, identity.userId) : null));
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === "function" ? (initial as () => T)() : initial;
    if (!key) return fallback;
    try {
      const stored = localStorage.getItem(key);
      return stored
        ? decodeDraft((JSON.parse(stored) as { value: unknown }).value, fallback)
        : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    const restore = (event: Event) => {
      const detail = (event as CustomEvent<{ form: string; sourceTab: string; userId: string }>)
        .detail;
      if (
        !key ||
        identity.generation !== databaseIdentity().generation ||
        detail.userId !== identity.userId ||
        !(form === detail.form || form.startsWith(`${detail.form}:`))
      )
        return;
      const source = `${PREFIX}${encodeURIComponent(detail.userId)}:${detail.sourceTab}:${form}`;
      try {
        const stored = localStorage.getItem(source);
        if (!stored) return;
        const parsed = JSON.parse(stored) as { value: T; updatedAt?: unknown };
        const restored = parsed.value;
        if (containsSecret(restored)) return;
        localStorage.setItem(
          key,
          JSON.stringify({ value: restored, updatedAt: Date.now(), revision: crypto.randomUUID() }),
        );
        // 불러온 버전은 다시 권하지 않는다. 다시 뜨면 이 탭에서 저장한 뒤 같은 기록을 한 번 더
        // 등록할 수 있다. 원본 탭이 아직 그 폼을 쓰고 있을 수 있어 원본은 지우지 않고, 원본이
        // 고쳐지면(`updatedAt` 변경) 다시 권한다.
        if (detail.sourceTab !== tabId())
          localStorage.setItem(
            RESTORED_PREFIX + source.slice(PREFIX.length),
            String(parsed.updatedAt),
          );
        setValue((previous) => decodeDraft(restored, previous));
      } catch {
        draftEvents.dispatchEvent(new Event("storage-error"));
      }
    };
    draftEvents.addEventListener("restore", restore);
    return () => draftEvents.removeEventListener("restore", restore);
  }, [form, identity.userId, identity.generation, key]);
  const setDraft: Dispatch<SetStateAction<T>> = (next) => {
    setValue((previous) => {
      const updated = typeof next === "function" ? (next as (prev: T) => T)(previous) : next;
      if (
        key &&
        identity.userId === databaseIdentity().userId &&
        identity.generation === databaseIdentity().generation &&
        !containsSecret(updated) &&
        !/password|secret|token|api.?key|credential/i.test(form)
      ) {
        try {
          localStorage.setItem(
            key,
            JSON.stringify({
              value: updated,
              updatedAt: Date.now(),
              revision: crypto.randomUUID(),
            }),
          );
        } catch {
          draftEvents.dispatchEvent(new Event("storage-error"));
        }
      }
      return updated;
    });
  };
  // 성공한 제출의 초안을 clearSubmittedDraft로 지운 뒤 새 폼만 초기화할 때 사용한다.
  // 아직 입력하지 않은 기본값을 작성 중 초안으로 저장하지 않는다.
  return [value, setDraft, setValue];
}
