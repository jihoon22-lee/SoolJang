/**
 * 범주형 차트 팔레트.
 *
 * `styles.css` 의 `--chart-1`~`--chart-6` 과 반드시 같은 값이어야 한다 — SVG `fill` 속성은
 * CSS 커스텀 프로퍼티를 직접 읽지 못해(엘리먼트가 실제로 그려지기 전에는
 * `getComputedStyle` 도 신뢰할 수 없다) 여기 리터럴로 다시 적는다. 팔레트를 바꿀 땐 두
 * 곳을 함께 고친다.
 */
export const CHART_PALETTE: readonly string[] = [
  "#ddb161", // 골드 (accent-strong)
  "#7fbf95", // 세이지 (ok)
  "#e8837a", // 코랄 (danger)
  "#7aa7e8", // 블루
  "#b98ae0", // 퍼플
  "#5fb8b0", // 틸
];

/** 팔레트를 순환한다 — 범주 수가 색보다 많아도 항상 색을 돌려준다. */
export function colorFor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length] as string;
}
