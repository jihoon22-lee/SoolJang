import { describe, expect, it } from "vitest";
import {
  convertedPaidPrice,
  foreignPriceMismatch,
  foreignPriceProblem,
  sameAmount,
} from "@/domain/purchaseFx";
import fixture from "../../../tests/fixtures/purchase_fx_cases.json";

interface ForeignPriceCase {
  name: string;
  currency: string;
  fx_rate: string | null;
  foreign_unit_price: string | null;
  unit_paid_price: string | null;
  problem: string | null;
  converted_won?: string;
}

describe("foreignPriceProblem — 공유 경계값 (tests/fixtures/purchase_fx_cases.json)", () => {
  it.each(fixture.cases as ForeignPriceCase[])("$name", (item) => {
    expect(
      foreignPriceProblem({
        currency: item.currency,
        fxRate: item.fx_rate,
        foreignUnitPrice: item.foreign_unit_price,
        unitPaidPrice: item.unit_paid_price,
      }),
    ).toBe(item.problem);
    if (item.converted_won !== undefined && item.foreign_unit_price && item.fx_rate)
      expect(convertedPaidPrice(item.foreign_unit_price, item.fx_rate)).toBe(item.converted_won);
  });
});

it("외화 단가 × 환율과 원화 실구매가가 1% 넘게 다르면 어긋난 기록으로 본다", () => {
  const foreign = { foreign_unit_price: "10", fx_rate: "1350" };
  expect(foreignPriceMismatch({ ...foreign, unit_paid_price: "13500" })).toBe(false);
  // 줄여 적은 환율로 생긴 1% 안의 차이는 같은 값으로 본다.
  expect(foreignPriceMismatch({ ...foreign, unit_paid_price: "13600" })).toBe(false);
  expect(foreignPriceMismatch({ ...foreign, unit_paid_price: "135" })).toBe(true);
  expect(foreignPriceMismatch({ ...foreign, unit_paid_price: null })).toBe(false);
  expect(
    foreignPriceMismatch({ foreign_unit_price: null, fx_rate: null, unit_paid_price: "135" }),
  ).toBe(false);
});

it("외화 환산은 부동소수 오차 없이 원 단위 반올림한다", () => {
  // 2.675 × 100 은 부동소수로 267.4999…라 267이 됐다. 정확한 값 267.5는 268이다.
  expect(convertedPaidPrice("2.675", "100")).toBe("268");
  expect(convertedPaidPrice("46.67", "1431.9")).toBe("66827");
  expect(convertedPaidPrice("5980", "9.12")).toBe("54538");
  expect(convertedPaidPrice("0.5", "1")).toBe("1");
  expect(convertedPaidPrice(".5", "3")).toBe("2");
  expect(convertedPaidPrice("46.", "2")).toBe("92");
  expect(convertedPaidPrice(".", "2")).toBeNull();
  expect(convertedPaidPrice("10", "0")).toBeNull();
  expect(convertedPaidPrice("", "1")).toBeNull();
  expect(convertedPaidPrice("1e3", "1")).toBeNull();
  expect(convertedPaidPrice("-1", "1")).toBeNull();
});

it("저장 형식이 달라도 같은 수는 같은 값으로 본다", () => {
  expect(sameAmount("1431.9", "1431.900000")).toBe(true);
  expect(sameAmount("46.67", "46.670")).toBe(true);
  expect(sameAmount("1500", "1431.9")).toBe(false);
  expect(sameAmount("", "")).toBe(true);
  expect(sameAmount("", "0")).toBe(false);
});
