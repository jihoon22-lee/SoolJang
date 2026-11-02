/**
 * 외화 구매의 통화·환율·외화 단가·원화 실구매가 정합성(D276).
 *
 * 서버 `src/sooljang/domain/purchase_fx.py`와 같은 규칙이다. 등록·수정·동기화는 서버가 최종으로
 * 검사하고, 폼은 보내기 전에 같은 규칙으로 막는다. 두 구현은
 * `tests/fixtures/purchase_fx_cases.json` 경계값으로 대조한다.
 */
import Decimal from "decimal.js";
import type { Purchase } from "@/api/types";

/** 해외 구매에 자주 쓰는 통화. */
export const FOREIGN_CURRENCIES = ["USD", "JPY", "EUR", "GBP", "CNY", "HKD", "TWD", "SGD", "AUD"];

/** 구매 금액 열(Numeric(14, 2))에 저장 자릿수로 반올림해도 담기는 상한(미만). 서버와 같다. */
const MAX_AMOUNT = "999999999999.995";
// 금액(정수 12자리 + 소수 2자리) × 환율(정수 8자리 + 소수 6자리)을 반올림 없이 담는 자릿수.
const Exact = Decimal.clone({ precision: 40 });

export type ForeignPriceProblem =
  | "fx_rate_required"
  | "currency_not_foreign"
  | "too_large"
  | "paid_mismatch";

/** 서버 `ForeignPriceError`와 같은 문구. */
export const FOREIGN_PRICE_MESSAGES: Record<ForeignPriceProblem, string> = {
  fx_rate_required: "외화 단가를 넣으려면 환율이 필요합니다",
  currency_not_foreign: "외화 단가에는 원화가 아닌 통화 코드가 필요합니다",
  too_large: "외화 단가 × 환율이 저장할 수 있는 금액보다 큽니다",
  paid_mismatch: "병당 실구매가가 외화 단가 × 환율과 1% 넘게 다릅니다",
};

export interface ForeignPriceInput {
  currency: string;
  fxRate: string | null;
  foreignUnitPrice: string | null;
  unitPaidPrice: string | null;
}

function exact(value: string | null): Decimal | null {
  if (value === null || !value.trim()) return null;
  try {
    const amount = new Exact(value.trim());
    return amount.isFinite() ? amount : null;
  } catch {
    return null;
  }
}

/**
 * 서버가 거절할 외화 구매 값의 이유. 문제가 없으면 null 이다. 외화 단가가 없으면 검사하지 않고,
 * 비운 실구매가는 서버가 환산값으로 채우므로 문제로 보지 않는다.
 */
export function foreignPriceProblem(input: ForeignPriceInput): ForeignPriceProblem | null {
  const foreign = exact(input.foreignUnitPrice);
  if (foreign === null) return null;
  const rate = exact(input.fxRate);
  if (rate === null) return "fx_rate_required";
  if (input.currency.trim().toUpperCase() === "KRW") return "currency_not_foreign";
  const converted = foreign.times(rate);
  if (converted.greaterThanOrEqualTo(MAX_AMOUNT)) return "too_large";
  const paid = exact(input.unitPaidPrice);
  if (paid === null) return null;
  const tolerance = Exact.max(1, converted.dividedBy(100));
  return paid.minus(converted).abs().greaterThan(tolerance) ? "paid_mismatch" : null;
}

/**
 * 외화 단가 × 환율과 원화 실구매가가 1%(최소 1원) 넘게 다른 구매. 레거시·검사 전 수정으로
 * 어긋난 기록을 맞는 것처럼 나란히 보이지 않게 표시한다.
 */
export function foreignPriceMismatch(
  purchase: Pick<Purchase, "foreign_unit_price" | "fx_rate" | "unit_paid_price">,
): boolean {
  if (!purchase.foreign_unit_price || !purchase.fx_rate || purchase.unit_paid_price == null)
    return false;
  return (
    foreignPriceProblem({
      currency: "",
      fxRate: purchase.fx_rate,
      foreignUnitPrice: purchase.foreign_unit_price,
      unitPaidPrice: purchase.unit_paid_price,
    }) === "paid_mismatch"
  );
}

/** "12.34" → [1234n, 2]. 음수·지수 표기·빈 값은 null. */
function decimalParts(value: string): [bigint, number] | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const fraction = match[2] ?? "";
  return [BigInt(`${match[1] ?? ""}${fraction}` || "0"), fraction.length];
}

/**
 * 외화 단가 × 환율을 원 단위로 반올림(0.5는 올림)한 원화 실구매가. 둘 중 하나라도 없으면 null.
 * 부동소수 곱셈(2.675 × 100 = 267.4999…)으로 1원이 어긋나지 않게 정수로 계산한다.
 */
export function convertedPaidPrice(foreignUnitPrice: string, fxRate: string): string | null {
  const foreign = decimalParts(foreignUnitPrice);
  const rate = decimalParts(fxRate);
  if (!foreign || !rate || rate[0] === 0n) return null;
  const scale = 10n ** BigInt(foreign[1] + rate[1]);
  return String((foreign[0] * rate[0] * 2n + scale) / (2n * scale));
}

/** 같은 수인지(“1431.9”와 “1431.900000”). 읽을 수 없으면 글자 그대로 비교한다. */
export function sameAmount(left: string, right: string): boolean {
  const a = exact(left);
  const b = exact(right);
  return a !== null && b !== null ? a.equals(b) : left.trim() === right.trim();
}
