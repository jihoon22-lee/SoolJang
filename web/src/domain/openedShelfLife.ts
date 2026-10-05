/**
 * 개봉 후 권장 소비 기간(대략). 열린 병을 오래 두면 맛이 변하는 주종을 홈에서 알린다.
 *
 * 정확한 보관 기준이 아니라 "한 번 확인해 보라" 는 알림용 기준이다. 주종 경로 이름에
 * 들어 있는 낱말로 고른다(사용자가 주종 이름을 바꿔도 대부분 맞게). 증류주처럼 오래가는
 * 술은 알리지 않는다(null).
 */

const RULES: { keywords: string[]; days: number; label: string }[] = [
  { keywords: ["맥주", "막걸리", "탁주", "생주"], days: 3, label: "맥주·막걸리" },
  { keywords: ["와인", "샴페인", "스파클링"], days: 7, label: "와인" },
  { keywords: ["사케", "청주", "약주", "니혼슈"], days: 30, label: "청주·사케" },
  { keywords: ["리큐르", "포트", "셰리", "베르무트"], days: 90, label: "주정강화·리큐르" },
];

export interface ShelfLife {
  days: number;
  label: string;
}

export function openedShelfLife(categoryPath: readonly string[]): ShelfLife | null {
  const names = categoryPath.join(" ");
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => names.includes(keyword))) {
      return { days: rule.days, label: rule.label };
    }
  }
  return null;
}

/** 개봉일부터 오늘(YYYY-MM-DD)까지 지난 날 수. */
export function daysSince(openedOn: string, today: string): number {
  const start = Date.parse(`${openedOn}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((end - start) / 86_400_000));
}
