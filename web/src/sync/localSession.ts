/** 로컬 오프라인 접근 기록. 인증 토큰을 보관하지 않으며 서버 권한을 대신하지 않는다. */
import type { User } from "@/api/types";
export const LOCAL_SESSION_KEY = "sooljang-local-session-v1";
const OFFLINE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
interface LocalSession {
  user: User;
  verifiedAt: number;
}
export function rememberLocalSession(user: User): void {
  try {
    localStorage.setItem(
      LOCAL_SESSION_KEY,
      JSON.stringify({ user, verifiedAt: Date.now() } satisfies LocalSession),
    );
  } catch {
    /* Online access remains available if local storage is disabled. */
  }
}
export function forgetLocalSession(): void {
  localStorage.removeItem(LOCAL_SESSION_KEY);
}
export function offlineSession(): User | null {
  try {
    const stored = JSON.parse(
      localStorage.getItem(LOCAL_SESSION_KEY) ?? "null",
    ) as LocalSession | null;
    if (
      !stored ||
      typeof stored.user?.id !== "string" ||
      !Number.isFinite(stored.verifiedAt) ||
      stored.verifiedAt > Date.now() ||
      Date.now() - stored.verifiedAt > OFFLINE_SESSION_MS
    )
      return null;
    return stored.user;
  } catch {
    return null;
  }
}
