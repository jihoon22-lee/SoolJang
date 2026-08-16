/**
 * 재고 우선 정렬 켬/끔 기억.
 *
 * 기기별 표시 설정이라 서버에 동기화할 이유가 없다(`lastVendor.ts` 와 같은 이유).
 * 기본값은 켬 — 재고 있는 술, 그중에서도 미개봉 재고가 있는 술을 찾아 고칠 확률이
 * 가장 높다는 게 근거다.
 */

const STORAGE_KEY = "sooljang:products-stock-first";

export function getStockFirstPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    // 프라이빗 브라우징 등 localStorage 를 쓸 수 없는 환경 — 기본값(켬)으로 진행한다.
    return true;
  }
}

export function setStockFirstPreference(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // 위와 같은 이유로 조용히 무시한다 — 기억 못 하는 것뿐 기능이 막히면 안 된다.
  }
}
