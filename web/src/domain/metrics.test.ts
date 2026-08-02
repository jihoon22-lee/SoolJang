import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  type BottleRecord,
  bottleTallyDisposed,
  bottleTallyInStock,
  bottleTallyTotal,
  computePriceMetrics,
  type PriceMetrics,
  purchaseLot,
  tallyBottles,
  valueForMoney,
} from "@/domain/metrics";
import fixture from "../../../tests/fixtures/metrics_cases.json";

interface PriceMetricsCase {
  name: string;
  lots: {
    quantity: number;
    volume_ml: number;
    unit_list_price: string | null;
    unit_paid_price: string | null;
  }[];
  expected: Partial<Record<keyof PriceMetrics | "list_total" | "avg_list_price", unknown>>;
}

const EXPECTED_KEY_MAP: Record<string, keyof PriceMetrics> = {
  purchased_count: "purchasedCount",
  priced_quantity: "pricedQuantity",
  paid_quantity: "paidQuantity",
  list_total: "listTotal",
  paid_total: "paidTotal",
  avg_list_price: "avgListPrice",
  avg_paid_price: "avgPaidPrice",
  price_per_100ml: "pricePer100ml",
  price_per_100ml_paid: "pricePer100mlPaid",
  discount_rate: "discountRate",
  total_volume_ml: "totalVolumeMl",
};

const DECIMAL_KEYS = new Set<keyof PriceMetrics>([
  "listTotal",
  "paidTotal",
  "avgListPrice",
  "avgPaidPrice",
  "pricePer100ml",
  "pricePer100mlPaid",
  "discountRate",
]);

describe("computePriceMetrics — 공유 골든값 (tests/fixtures/metrics_cases.json)", () => {
  const cases = fixture.price_metrics_cases as unknown as PriceMetricsCase[];

  it.each(cases)("$name", ({ lots, expected }) => {
    const parsedLots = lots.map((lot) =>
      purchaseLot(
        lot.quantity,
        lot.volume_ml,
        lot.unit_list_price === null ? null : new Decimal(lot.unit_list_price),
        lot.unit_paid_price === null ? null : new Decimal(lot.unit_paid_price),
      ),
    );
    const metrics = computePriceMetrics(parsedLots);

    for (const [jsonKey, expectedValue] of Object.entries(expected)) {
      const tsKey = EXPECTED_KEY_MAP[jsonKey];
      if (!tsKey) throw new Error(`알 수 없는 픽스처 키: ${jsonKey}`);
      const actual = metrics[tsKey];

      if (expectedValue === null) {
        expect(actual, `${jsonKey} 은 null 이어야 함`).toBeNull();
      } else if (DECIMAL_KEYS.has(tsKey)) {
        // list_total·paid_total 은 quantize 되지 않은 원시 합계라 소수 자릿수가 픽스처마다
        // 다를 수 있다("23980" vs "23980.00") — 문자열이 아니라 수치로 비교한다.
        expect(actual, `${jsonKey}`).not.toBeNull();
        expect((actual as Decimal).equals(new Decimal(expectedValue as string)), jsonKey).toBe(
          true,
        );
      } else {
        expect(actual).toBe(expectedValue);
      }
    }
  });
});

describe("tallyBottles — 공유 골든값", () => {
  it("상태별로 정확히 센다", () => {
    const { statuses, expected } = fixture.bottle_tally_case;
    const bottles: BottleRecord[] = statuses.map((status) => ({
      status,
      openedOn: null,
      finishedOn: null,
    }));

    const tally = tallyBottles(bottles);

    expect(tally.unopened).toBe(expected.unopened);
    expect(tally.open).toBe(expected.open);
    expect(tally.finished).toBe(expected.finished);
    expect(tally.gifted).toBe(expected.gifted);
    expect(tally.sold).toBe(expected.sold);
    expect(bottleTallyInStock(tally)).toBe(expected.in_stock);
    expect(bottleTallyDisposed(tally)).toBe(expected.disposed);
    expect(bottleTallyTotal(tally)).toBe(expected.total);
  });
});

describe("valueForMoney", () => {
  it("가격이 저렴할수록 값이 높다", () => {
    const cheap = valueForMoney(new Decimal("4.5"), new Decimal("3000"));
    const expensive = valueForMoney(new Decimal("4.5"), new Decimal("30000"));

    expect(cheap).not.toBeNull();
    expect(expensive).not.toBeNull();
    expect(cheap?.greaterThan(expensive as Decimal)).toBe(true);
  });

  it.each([
    [null, new Decimal("3000")],
    [new Decimal("4.5"), null],
    [new Decimal("4.5"), new Decimal(0)],
  ])("정의되지 않는 경우 null 을 반환한다", (rating, price) => {
    expect(valueForMoney(rating, price)).toBeNull();
  });
});
