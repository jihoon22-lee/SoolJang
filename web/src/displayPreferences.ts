/**
 * 화면 표시 설정(기기별). 서버에 동기화할 이유가 없는 보기 취향이다.
 *
 * - 표 밀도: 넉넉하게(기본) / 촘촘하게. 수백 행을 한 화면에 더 보고 싶을 때만 바꾼다.
 */

export type Density = "comfortable" | "compact";

const DENSITY_KEY = "sooljang:table-density";
export const DISPLAY_PREFERENCES_CHANGED = "sooljang:display-preferences";

export function getDensity(): Density {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function setDensity(value: Density): void {
  try {
    window.localStorage.setItem(DENSITY_KEY, value);
  } catch {
    // 기억하지 못할 뿐 지금 화면에는 반영한다.
  }
  window.dispatchEvent(
    new CustomEvent(DISPLAY_PREFERENCES_CHANGED, { detail: { density: value } }),
  );
}
