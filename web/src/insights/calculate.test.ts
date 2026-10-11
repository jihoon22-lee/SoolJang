import { expect, it } from "vitest";
import { calculateInsights, type InsightSnapshot } from "@/insights/calculate";
import type { SyncRow } from "@/sync/db";
import inventoryFixture from "../../../tests/fixtures/category_inventory_cases.json";
import metricsFixture from "../../../tests/fixtures/metrics_cases.json";

const row = (id: string, fields: Record<string, unknown> = {}): SyncRow => ({
  id,
  user_id: "u",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...fields,
});
function fixture(): InsightSnapshot {
  return {
    categories: [
      row("root", { name: "양주" }),
      row("child", { name: "위스키", parent_id: "root" }),
      row("beer", { name: "맥주" }),
    ],
    products: [
      row("p", {
        name: "합성 위스키",
        category_id: "child",
        personal_rating: "5.0",
        producer_id: "maker",
        country: "영국",
        region: "스코틀랜드",
      }),
      row("q", { name: "합성 맥주", category_id: "beer" }),
    ],
    skus: [
      row("s", { product_id: "p", volume_ml: 700 }),
      row("sq", { product_id: "q", volume_ml: 500 }),
    ],
    purchases: [
      row("pu", {
        sku_id: "s",
        quantity: 3,
        unit_paid_price: "10000.10",
        purchased_on: "2026-01-02",
        currency: "KRW",
      }),
      row("pq", { sku_id: "sq", quantity: 1, purchased_on: null }),
    ],
    bottles: [
      row("open", {
        purchase_id: "pu",
        label_no: 1,
        status: "open",
        opened_on: "2026-01-03",
        remaining_ml: null,
      }),
      row("sealed", { purchase_id: "pu", label_no: 2, status: "unopened", remaining_ml: null }),
      row("finished", {
        purchase_id: "pu",
        label_no: 3,
        status: "finished",
        finished_on: "2026-02-01",
        remaining_ml: 0,
      }),
      row("bq", { purchase_id: "pq", label_no: 1, status: "unopened" }),
    ],
    tastings: [
      row("t1", {
        sku_id: "s",
        bottle_id: "open",
        tasted_on: "2026-01-05",
        rating: "0.0",
        poured_ml: 30,
      }),
      row("t2", {
        sku_id: "s",
        bottle_id: "open",
        tasted_on: "2026-02-02",
        rating: "4.0",
        poured_ml: 50,
      }),
    ],
    producers: [row("maker", { name: "합성 생산자" })],
    vendors: [],
  };
}
const filters = { from: "2026-02-01", to: "2026-02-28", categoryId: "", status: "all" };
it("기간이 달라도 현재 재고는 그대로이며 날짜가 확인된 사건만 기간에 센다", () => {
  const value = calculateInsights(fixture(), filters, "2026-03-01");
  expect(value.inventory).toMatchObject({
    bottles: 3,
    unopened: 2,
    opened: 1,
    knownRemainingMl: 1200,
    unknownRemaining: 1,
    cost: "20000.20",
  });
  expect(value.period).toMatchObject({
    purchasedBottles: 0,
    finished: 1,
    tastings: 1,
    spend: "0.00",
  });
  expect(value.previous).toMatchObject({ purchasedBottles: 0, tastings: 1 });
  expect(value.coverage.find((x) => x.key === "purchase-date")?.items).toHaveLength(1);
});
it("상위 주종 필터는 하위를 포함하고 현재 상태로 선택한 병의 사건만 계산한다", () => {
  const value = calculateInsights(
    fixture(),
    { ...filters, from: "2026-01-01", categoryId: "root", status: "open" },
    "2026-03-01",
  );
  expect(value.inventory.bottles).toBe(1);
  expect(value.period).toMatchObject({
    purchasedBottles: 1,
    spend: "10000.10",
    finished: 0,
    tastings: 2,
  });
  expect(value.inventory.unknownRemaining).toBe(1);
  expect(value.period.evidence.find((item) => item.purchaseId === "pu")?.detail).toContain(
    "선택 1병 / 구매 3병",
  );
  expect(value.openBottles[0]).toMatchObject({
    openedDays: 57,
    bottleId: "open",
    skuId: "s",
    productId: "p",
  });
});
it("제품 총평과 세션 평점을 분리하고 0점과 미평가의 표본수를 보존한다", () => {
  const value = calculateInsights(fixture(), { ...filters, from: "2026-01-01" }, "2026-03-01");
  const group = value.ratings.category.find((x) => x.label.includes("위스키"));
  expect(group?.products).toMatchObject({ count: 1, average: 5 });
  expect(group?.sessions).toMatchObject({ count: 2, average: 2 });
  expect(group?.sessions.bins[0]).toBe(1);
  expect(value.untried.map((x) => x.productId)).toEqual(["q"]);
  expect(value.changes[0]).toMatchObject({ count: 2, firstRating: 0, lastRating: 4, delta: 4 });
});
it("같은 SKU라도 통화·구매조건·구매처종류를 합치지 않고 0원은 유상 중앙값에서 뺀다", () => {
  const data = fixture();
  data.purchases.push(
    row("free", { sku_id: "s", quantity: 1, purchased_on: "2026-02-01", currency: "KRW" }),
    row("usd", {
      sku_id: "s",
      quantity: 1,
      unit_paid_price: "20000",
      purchased_on: "2026-02-02",
      currency: "USD",
    }),
    row("coupon", {
      sku_id: "s",
      quantity: 1,
      unit_paid_price: "8000",
      purchased_on: "2026-02-03",
      currency: "KRW",
      discount_note: "회원 쿠폰",
    }),
  );
  const value = calculateInsights(data, { ...filters, from: "2026-01-01" }, "2026-03-01");
  expect(value.prices).toHaveLength(3); // dated whisky KRW/USD/coupon; undated beer is excluded
  const base = value.prices.find(
    (x) => x.skuId === "s" && x.currency === "KRW" && x.condition === "조건 미기록",
  );
  expect(base).toMatchObject({
    count: 2,
    zeroCount: 1,
    paidCount: 1,
    paidMedian: "10000.10",
    minimum: "0.00",
  });
});
it("삭제 행·알 수 없는 연결은 집계에서 제외하고 미래 개봉일을 경과일로 꾸미지 않는다", () => {
  const data = fixture();
  data.bottles = data.bottles.map((bottle) =>
    bottle.id === "open" ? { ...bottle, opened_on: "2026-04-01" } : bottle,
  );
  data.bottles.push(
    row("bad", { purchase_id: "missing", status: "open" }),
    row("deleted", { purchase_id: "pu", status: "unopened", deleted_at: "2026-02-01" }),
  );
  const value = calculateInsights(data, filters, "2026-03-01");
  expect(value.inventory.bottles).toBe(3);
  expect(value.openBottles[0]?.openedDays).toBeNull();
  expect(value.coverage.find((x) => x.key === "orphan")?.items).toHaveLength(1);
});
it("같은 날의 반복 평점은 순서를 추정하지 않고 날짜별 평균으로만 비교한다", () => {
  const data = fixture();
  data.tastings = data.tastings.map((tasting) => ({ ...tasting, tasted_on: "2026-01-05" }));
  const value = calculateInsights(data, { ...filters, from: "2026-01-01" }, "2026-03-01");
  expect(value.changes[0]).toMatchObject({ count: 2, firstRating: 2, lastRating: 2, delta: null });
});

it("병 없는 시음에는 제품의 다른 구매 가격을 대신 붙이지 않는다", () => {
  const data = fixture();
  data.tastings = [
    row("standalone", { sku_id: "s", bottle_id: null, tasted_on: "2026-02-01", rating: "4" }),
  ];
  const value = calculateInsights(data, filters, "2026-03-01");
  expect(
    value.ratings.price.find((group) => group.label === "구매 연결 없음")?.sessions.count,
  ).toBe(1);
  expect(
    value.ratings.price
      .filter((group) => group.label !== "구매 연결 없음")
      .every((group) => group.sessions.count === 0),
  ).toBe(true);
});

it("시음 SKU와 병 구매 SKU의 연결이 다르면 잘못된 제품·가격에 합산하지 않는다", () => {
  const data = fixture();
  data.tastings = [
    row("wrong-link", { sku_id: "sq", bottle_id: "open", tasted_on: "2026-02-02", rating: "5" }),
  ];
  const value = calculateInsights(data, filters, "2026-03-01");
  expect(value.period.tastings).toBe(0);
  expect(
    value.coverage.find((item) => item.key === "orphan")?.items.map((item) => item.id),
  ).toContain("wrong-link");
});

it("구매건별 중앙값은 병수로 가중하지 않고 판매·증여 날짜도 별도로 센다", () => {
  const data = fixture();
  data.purchases.push(
    row("p2", {
      sku_id: "s",
      quantity: 100,
      purchased_on: "2026-02-01",
      unit_paid_price: "20000.30",
      currency: "KRW",
    }),
  );
  data.bottles.push(
    row("gifted", { purchase_id: "pu", status: "gifted", finished_on: "2026-02-03" }),
    row("sold", { purchase_id: "pu", status: "sold", finished_on: "2026-02-04" }),
  );
  const value = calculateInsights(data, { ...filters, from: "2026-01-01" }, "2026-03-01");
  expect(value.prices.find((group) => group.skuId === "s")?.median).toBe("15000.20");
  expect(value.period).toMatchObject({
    purchasedBottles: 103,
    spend: "2030030.30",
    gifted: 1,
    sold: 1,
  });
  expect(value.monthly.find((month) => month.month === "2026-02")?.gifted).toBe(1);
});

it("최근 구매일에 여러 구매가 있으면 순서를 추정하지 않고 표본수와 가격 범위를 제공한다", () => {
  const data = fixture();
  data.purchases.push(
    row("same-day-one", {
      sku_id: "s",
      quantity: 1,
      purchased_on: "2026-02-05",
      unit_paid_price: "12000",
      currency: "KRW",
    }),
    row("same-day-two", {
      sku_id: "s",
      quantity: 1,
      purchased_on: "2026-02-05",
      unit_paid_price: "14000",
      currency: "KRW",
    }),
  );
  const value = calculateInsights(data, { ...filters, from: "2026-01-01" }, "2026-03-01");
  expect(value.prices.find((group) => group.skuId === "s")).toMatchObject({
    latestOn: "2026-02-05",
    latestCount: 2,
    latestMinimum: "12000.00",
    latestMaximum: "14000.00",
  });
});

it("Python과 공유하는 혼합 상태 fixture의 현재 재고·하위 주종 합계를 유지한다", () => {
  const data = fixture();
  data.purchases = [];
  data.bottles = [];
  data.skus = [];
  data.tastings = [];
  data.products = [row("p", { category_id: "child" }), row("q", { category_id: null })];
  for (const [i, lot] of inventoryFixture.lots.entries()) {
    data.skus.push(row(`s${i}`, { product_id: lot.category ? "p" : "q", volume_ml: lot.volume }));
    data.purchases.push(row(`p${i}`, { sku_id: `s${i}`, quantity: lot.states.length }));
    lot.states.forEach((status, j) => {
      data.bottles.push(row(`b${i}-${j}`, { purchase_id: `p${i}`, status }));
    });
  }
  const value = calculateInsights(data, { ...filters, categoryId: "root" }, "2026-03-01");
  expect(value.inventory).toMatchObject({
    bottles: inventoryFixture.expected.root.in_stock_count,
    products: inventoryFixture.expected.root.product_count,
    unopened: inventoryFixture.expected.root.unopened_count,
    opened: inventoryFixture.expected.root.opened_count,
  });
});

it("첫 시음이 구매보다 빠른 병은 간격 표본에서 빼고 원본 시음과 구매 맥락을 점검 근거로 제공한다", () => {
  const data = fixture();
  data.tastings = [
    row("early", { sku_id: "s", bottle_id: "open", tasted_on: "2026-01-01", rating: "3" }),
  ];
  const value = calculateInsights(data, { ...filters, from: "2026-01-01" }, "2026-03-01");
  expect(value.firstTasting.count).toBe(0);
  expect(value.coverage.find((item) => item.key === "first-before-purchase")?.items).toEqual([
    expect.objectContaining({
      tastingId: "early",
      bottleId: "open",
      purchaseId: "pu",
      skuId: "s",
      productId: "p",
    }),
  ]);
});

it("같은 이름·숙성연수·용량의 다른 도수 제품을 가격 묶음과 근거에서도 구분한다", () => {
  const data = fixture();
  data.products = [
    row("p", { name: "합성 위스키", age_years: "12", abv: "40" }),
    row("q", { name: "합성 위스키", age_years: "12", abv: "46" }),
  ];
  data.skus = [
    row("s", { product_id: "p", volume_ml: 700 }),
    row("sq", { product_id: "q", volume_ml: 700 }),
  ];
  data.purchases = [
    row("pu", { sku_id: "s", quantity: 1, purchased_on: "2026-02-02", unit_paid_price: "10000" }),
    row("pq", { sku_id: "sq", quantity: 1, purchased_on: "2026-02-02", unit_paid_price: "10000" }),
  ];
  const value = calculateInsights(data, filters, "2026-03-01");
  expect(new Set(value.prices.map((price) => price.label)).size).toBe(2);
  expect(value.prices.find((price) => price.skuId === "s")?.evidence[0]?.label).toContain("40%");
  expect(value.prices.find((price) => price.skuId === "sq")?.evidence[0]?.label).toContain("46%");
});

it.each(
  metricsFixture.product_metrics_cases,
)("재고 원가는 공통 Python/홈 골든값을 따른다: $name", (item) => {
  const data: InsightSnapshot = {
    categories: [],
    products: [row("p")],
    producers: [],
    vendors: [],
    tastings: [],
    skus: item.skus.map((sku) => row(sku.sku_id, { product_id: "p", volume_ml: sku.volume_ml })),
    purchases: item.lots.map((lot) => row(lot.purchase_id, { ...lot, purchased_on: "2026-01-01" })),
    bottles: item.bottles.map((bottle) => row(bottle.bottle_id, bottle)),
  };
  expect(calculateInsights(data, filters, "2026-03-01").inventory.cost).toBe(
    item.expected.metrics.inventory_value_at_cost,
  );
});

it("남은 고가 구매 병에도 SKU 전체 구매 가중 실평단가를 쓰며 날짜·상태 필터는 평균을 바꾸지 않는다", () => {
  const data = fixture();
  data.products = [row("p")];
  data.skus = [row("s", { product_id: "p", volume_ml: 700 })];
  data.purchases = [
    row("cheap", {
      sku_id: "s",
      quantity: 1,
      unit_paid_price: "10000",
      purchased_on: "2026-01-01",
    }),
    row("expensive", {
      sku_id: "s",
      quantity: 1,
      unit_paid_price: "20000",
      purchased_on: "2026-02-01",
    }),
  ];
  data.bottles = [
    row("done", { purchase_id: "cheap", status: "finished" }),
    row("held", { purchase_id: "expensive", status: "open", remaining_ml: 500 }),
  ];
  data.tastings = [];
  expect(calculateInsights(data, filters, "2026-03-01").inventory.cost).toBe("15000.00");
  expect(
    calculateInsights(data, { ...filters, from: "2026-01-01", status: "open" }, "2026-03-01")
      .inventory.cost,
  ).toBe("15000.00");
});
