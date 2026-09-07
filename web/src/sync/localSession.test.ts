import { afterEach, expect, it, vi } from "vitest";
import {
  forgetLocalSession,
  LOCAL_SESSION_KEY,
  offlineSession,
  rememberLocalSession,
} from "@/sync/localSession";

const user = {
  id: "owner",
  email: "fixture@example.com",
  display_name: "합성 사용자",
  role: "owner" as const,
  last_login_at: null,
};
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});
it("검증한 사용자 프로필만 오프라인 시작에 복원한다", () => {
  expect(offlineSession()).toBeNull();
  rememberLocalSession(user);
  expect(offlineSession()).toEqual(user);
  expect(localStorage.getItem(LOCAL_SESSION_KEY)).not.toContain("token");
  forgetLocalSession();
  expect(offlineSession()).toBeNull();
});
it("7일이 지난 로컬 세션은 온라인 재확인을 요구한다", () => {
  vi.useFakeTimers();
  rememberLocalSession(user);
  vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
  expect(offlineSession()).toBeNull();
});
it("손상된 로컬 기록은 인증이나 무한 로딩으로 이어지지 않는다", () => {
  localStorage.setItem(LOCAL_SESSION_KEY, "invalid");
  expect(offlineSession()).toBeNull();
});
