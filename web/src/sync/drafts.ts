/** 입력 중인 폼만 저장한다. 토큰·키·파일은 이 저장소로 받지 않는다. */
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { databaseIdentity } from "@/sync/db";

const PREFIX = "sooljang-draft-v1:";
const TAB_KEY = "sooljang-draft-tab";
export const draftEvents = new EventTarget();
/** 새 탭은 복제된 sessionStorage ID를 재사용하지 않는다. reload는 같은 draft를 연다. */
export function initializeDraftTab(): void {
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (navigation?.type === "navigate" || !sessionStorage.getItem(TAB_KEY))
    sessionStorage.setItem(TAB_KEY, crypto.randomUUID());
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
): [T, Dispatch<SetStateAction<T>>] {
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
        detail.userId !== identity.userId ||
        !(form === detail.form || form.startsWith(`${detail.form}:`))
      )
        return;
      const source = `${PREFIX}${encodeURIComponent(detail.userId)}:${detail.sourceTab}:${form}`;
      try {
        const stored = localStorage.getItem(source);
        if (!stored) return;
        const restored = (JSON.parse(stored) as { value: T }).value;
        if (containsSecret(restored)) return;
        localStorage.setItem(key, JSON.stringify({ value: restored, updatedAt: Date.now() }));
        setValue((previous) => decodeDraft(restored, previous));
      } catch {
        draftEvents.dispatchEvent(new Event("storage-error"));
      }
    };
    draftEvents.addEventListener("restore", restore);
    return () => draftEvents.removeEventListener("restore", restore);
  }, [form, identity.userId, key]);
  const setDraft: Dispatch<SetStateAction<T>> = (next) => {
    setValue((previous) => {
      const updated = typeof next === "function" ? (next as (prev: T) => T)(previous) : next;
      if (
        key &&
        identity.userId === databaseIdentity().userId &&
        !containsSecret(updated) &&
        !/password|secret|token|api.?key|credential/i.test(form)
      ) {
        try {
          localStorage.setItem(key, JSON.stringify({ value: updated, updatedAt: Date.now() }));
        } catch {
          draftEvents.dispatchEvent(new Event("storage-error"));
        }
      }
      return updated;
    });
  };
  return [value, setDraft];
}
