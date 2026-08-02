import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // App 이 URL 해시에 라우트를 pushState 한다(@/router) — 리셋하지 않으면 한 테스트의
  // 내비게이션이 다음 테스트 파일 실행 순서에 따라 다음 테스트의 초기 화면에 새어든다.
  window.history.replaceState(null, "", window.location.pathname);
});
