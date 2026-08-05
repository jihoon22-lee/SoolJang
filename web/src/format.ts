/**
 * 값 표시 형식.
 *
 * 가장 중요한 규칙: **금액이 `null` 이면 0원이 아니라 "가격 정보 없음" 이다.** 무료로 받은
 * 술과 가격을 기록하지 않은 술을 구분해야 한다. 이 규칙을 컴포넌트마다 되풀이하면 언젠가
 * 한 곳에서 빠지므로 여기 한 곳에 고정한다.
 */

import type { Money } from "@/api/types";

/** 금액 정보가 없을 때 표시할 문자열. */
export const NO_PRICE_LABEL = "가격 정보 없음";
/** 좁은 열에서 쓰는 짧은 표기. */
export const NO_PRICE_SHORT = "—";

export function formatMoney(value: Money, options?: { short?: boolean }): string {
  if (value === null || value === undefined || value === "") {
    return options?.short ? NO_PRICE_SHORT : NO_PRICE_LABEL;
  }
  const amount = Number(value);
  if (Number.isNaN(amount)) {
    return options?.short ? NO_PRICE_SHORT : NO_PRICE_LABEL;
  }
  return `${amount.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}원`;
}

export function formatVolume(volumeMl: number | null | undefined): string {
  if (volumeMl === null || volumeMl === undefined) return "—";
  if (volumeMl >= 1000 && volumeMl % 1000 === 0) return `${volumeMl / 1000}L`;
  return `${volumeMl.toLocaleString("ko-KR")}ml`;
}

export function formatAbv(abv: string | null | undefined): string {
  if (abv === null || abv === undefined || abv === "") return "—";
  const value = Number(abv);
  return Number.isNaN(value) ? "—" : `${trimZeros(value)}%`;
}

/** 개인 평점. 레거시 실측이 0.5 단위 6점 만점이었다. */
export const MAX_RATING = 6;

export function formatRating(rating: string | null | undefined): string {
  if (rating === null || rating === undefined || rating === "") return "—";
  const value = Number(rating);
  return Number.isNaN(value) ? "—" : `${trimZeros(value)} / ${MAX_RATING}`;
}

export function formatPercent(ratio: string | null | undefined): string {
  if (ratio === null || ratio === undefined || ratio === "") return "—";
  const value = Number(ratio);
  return Number.isNaN(value) ? "—" : `${Math.round(value * 1000) / 10}%`;
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "날짜 미기록";
  return date;
}

/** 개봉→소진 평균 일수. */
export function formatDays(days: string | null | undefined): string {
  if (days === null || days === undefined || days === "") return "—";
  const value = Number(days);
  return Number.isNaN(value) ? "—" : `${Math.round(value).toLocaleString("ko-KR")}일`;
}

/** 가성비(평점 ÷ 100ml당 가격, 1,000원 기준으로 정규화). 단위가 없어 그대로 숫자만 보여준다. */
export function formatValueForMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = Number(value);
  return Number.isNaN(num) ? "—" : num.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export function formatCategoryPath(path: string[]): string {
  return path.length === 0 ? "미분류" : path.join(" › ");
}

function trimZeros(value: number): string {
  return String(Number(value.toFixed(2)));
}

const BOTTLE_STATUS_LABELS: Record<string, string> = {
  unopened: "미개봉",
  open: "개봉",
  finished: "소진",
  gifted: "증여",
  sold: "판매",
};

export function formatBottleStatus(status: string): string {
  return BOTTLE_STATUS_LABELS[status] ?? status;
}

const VENDOR_KIND_LABELS: Record<string, string> = {
  mart: "마트",
  online: "온라인",
  duty_free: "면세점",
  bottle_shop: "주류샵",
  bar: "바",
  brewery: "양조장",
  event: "행사",
  gift: "선물",
  other: "기타",
};

export function formatVendorKind(kind: string): string {
  return VENDOR_KIND_LABELS[kind] ?? kind;
}
