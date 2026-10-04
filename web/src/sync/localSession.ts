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

/**
 * 서버 로그아웃을 확인하지 못한 상태. 오프라인에서 로그아웃하면 화면은 잠기지만 서버 쿠키는
 * 남아, 다음 온라인 실행에서 `/auth/me` 가 성공해 다시 로그인된 것처럼 보인다. 이 표시가
 * 있으면 다음 온라인 실행에서 먼저 서버 로그아웃을 마친다.
 */
const PENDING_LOGOUT_KEY = "sooljang-pending-logout-v1";
export function markPendingLogout(): void {
  try {
    localStorage.setItem(PENDING_LOGOUT_KEY, "1");
  } catch {
    /* 저장소가 막혀 있으면 다음 실행에서 다시 로그인된 상태로 보일 수 있다. */
  }
}
export function clearPendingLogout(): void {
  try {
    localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    /* 무시한다. */
  }
}
export function hasPendingLogout(): boolean {
  try {
    return localStorage.getItem(PENDING_LOGOUT_KEY) === "1";
  } catch {
    return false;
  }
}
