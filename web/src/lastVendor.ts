/**
 * 마지막으로 쓴 구매처 이름 기억.
 *
 * 사용자 요청: 구매 입력 시 구매처가 직전 사용값으로 미리 채워지면 좋겠다는 것. 매번
 * 같은 곳(자주 가는 마트)에서 사는 경우가 많아 반복 타이핑을 줄인다. 기기별 습관이라
 * 서버에 동기화할 이유가 없어 `localStorage` 로 충분하다.
 */

const STORAGE_KEY = "sooljang:last-vendor-name";

export function getLastVendorName(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    // 프라이빗 브라우징 등 localStorage 를 쓸 수 없는 환경 — 기본값 없이 그냥 진행한다.
    return "";
  }
}

export function setLastVendorName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // 위와 같은 이유로 조용히 무시한다 — 기억 못 하는 것뿐 기능이 막히면 안 된다.
  }
}
