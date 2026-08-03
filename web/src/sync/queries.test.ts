import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/sync/db";
import {
  getBottles,
  getCategoryRollup,
  getCategoryTree,
  getProducts,
  getStatsRankings,
  getStatsSummary,
} from "@/sync/queries";

const NOW = "2026-01-01T00:00:00Z";

function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    user_id: "u1",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  await db.transaction(
    "rw",
    [
      db.category,
      db.product,
      db.sku,
      db.purchase,
      db.bottle,
      db.producer,
      db.variety,
      db.product_variety,
      db.vendor,
    ],
    async () => {
      await Promise.all([
        db.category.clear(),
        db.product.clear(),
        db.sku.clear(),
        db.purchase.clear(),
        db.bottle.clear(),
        db.producer.clear(),
        db.variety.clear(),
        db.product_variety.clear(),
        db.vendor.clear(),
      ]);
    },
  );
});

describe("getCategoryTree", () => {
  it("깊이·경로·롤업 병수를 계산한다", async () => {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주", sort_order: 0, is_seeded: true }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키", sort_order: 0, is_seeded: true }),
    ]);
    await db.product.bulkPut([
      row({ id: "p1", category_id: "whisky", name: "글렌알라키" }),
      row({ id: "p2", category_id: "liquor", name: "브랜디" }),
    ]);

    const tree = await getCategoryTree();
    const whisky = tree.items.find((n) => n.id === "whisky");
    const liquor = tree.items.find((n) => n.id === "liquor");

    expect(whisky?.depth).toBe(2);
    expect(whisky?.path).toEqual(["양주", "위스키"]);
    expect(whisky?.product_count).toBe(1);
    // 상위 카테고리는 자신의 직접 제품(1) + 하위(위스키 1) = 2
    expect(liquor?.product_count).toBe(1);
    expect(liquor?.descendant_product_count).toBe(2);
  });
});

describe("getProducts", () => {
  it("구매·병 정보를 조인해 파생 지표를 계산한다", async () => {
    await db.product.put(
      row({
        id: "p1",
        name: "테스트 위스키",
        category_id: null,
        abv: "43.0",
        personal_rating: null,
      }),
    );
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 700 }));
    await db.purchase.put(
      row({
        id: "pu1",
        sku_id: "s1",
        quantity: 2,
        unit_list_price: "50000",
        unit_paid_price: "45000",
      }),
    );
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened", remaining_ml: null }),
      row({ id: "b2", purchase_id: "pu1", label_no: 2, status: "open", remaining_ml: 300 }),
    ]);

    const [product] = await getProducts({});

    expect(product?.metrics.purchased_count).toBe(2);
    expect(product?.metrics.in_stock_count).toBe(2);
    expect(product?.metrics.avg_list_price).toBe("50000.00");
    // 700ml, 50000원 → 100ml당 7142.86원
    expect(product?.metrics.price_per_100ml).toBe("7142.86");
  });

  it("q 필터는 부분 일치와 한글 초성 검색을 모두 지원한다", async () => {
    await db.product.bulkPut([
      row({ id: "p1", name: "글렌고인 15년" }),
      row({ id: "p2", name: "발베니 12년" }),
    ]);

    expect((await getProducts({ q: "글렌" })).map((p) => p.id)).toEqual(["p1"]);
    expect((await getProducts({ q: "ㄱㄹㄱㅇ" })).map((p) => p.id)).toEqual(["p1"]);
    expect((await getProducts({ q: "없는술" })).map((p) => p.id)).toEqual([]);
  });

  it("category_id 필터는 하위 주종을 포함한다", async () => {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주" }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
    ]);
    await db.product.bulkPut([
      row({ id: "p1", category_id: "whisky", name: "위스키 술" }),
      row({ id: "p2", category_id: null, name: "미분류 술" }),
    ]);

    const filtered = await getProducts({ category_id: "liquor" });
    expect(filtered.map((p) => p.id)).toEqual(["p1"]);
  });

  it("vendor_id 필터는 그 구매처에서 산 적 있는 제품만 남긴다", async () => {
    await db.product.bulkPut([
      row({ id: "p1", name: "A마트에서 산 술" }),
      row({ id: "p2", name: "B마트에서 산 술" }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 500 }),
      row({ id: "s2", product_id: "p2", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({ id: "pu1", sku_id: "s1", vendor_id: "vendorA", quantity: 1 }),
      row({ id: "pu2", sku_id: "s2", vendor_id: "vendorB", quantity: 1 }),
    ]);

    const filtered = await getProducts({ vendor_id: "vendorA" });
    expect(filtered.map((p) => p.id)).toEqual(["p1"]);
  });

  it("in_stock=false 는 재고가 없는 제품만 남긴다", async () => {
    await db.product.bulkPut([
      row({ id: "p1", name: "재고 있음" }),
      row({ id: "p2", name: "재고 없음" }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 500 }),
      row({ id: "s2", product_id: "p2", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({ id: "pu1", sku_id: "s1", quantity: 1 }),
      row({ id: "pu2", sku_id: "s2", quantity: 1 }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "finished", remaining_ml: 0 }),
    ]);

    const inStock = await getProducts({ in_stock: true });
    expect(inStock.map((p) => p.id)).toEqual(["p1"]);
  });

  it("sort=created_at 은 실제 등록 시각순으로 정렬하고, 방향 토글도 반영된다", async () => {
    // 예전엔 이 접근자가 항상 null 을 돌려줘 등록일 정렬이 조용히 id(UUIDv7, 생성
    // 시각순) 순으로 폴백했다 — "등록일" 을 골라도 실제로는 아무 효과가 없었고,
    // 그 폴백이 방향 반전 전에 끝나 오름/내림 토글도 무효했다. id 를 일부러
    // created_at 과 반대 순서로 둬서, 폴백이 아니라 실제 created_at 을 쓰는지 확인한다.
    await db.product.bulkPut([
      row({ id: "z-먼저", name: "먼저 등록", created_at: "2026-01-01T00:00:00Z" }),
      row({ id: "a-나중", name: "나중 등록", created_at: "2026-06-01T00:00:00Z" }),
    ]);

    const ascending = await getProducts({ sort: "created_at", order: "asc" });
    expect(ascending.map((p) => p.id)).toEqual(["z-먼저", "a-나중"]);

    const descending = await getProducts({ sort: "created_at", order: "desc" });
    expect(descending.map((p) => p.id)).toEqual(["a-나중", "z-먼저"]);
  });
});

describe("getBottles", () => {
  it("상태로 필터링한다", async () => {
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu1", label_no: 2, status: "finished", remaining_ml: 0 }),
    ]);

    const unopened = await getBottles({ status: "unopened" });
    expect(unopened.map((b) => b.id)).toEqual(["b1"]);

    const inStock = await getBottles({ in_stock: true });
    expect(inStock.map((b) => b.id)).toEqual(["b1"]);
  });
});

describe("통계", () => {
  async function seedStatsFixture() {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주" }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
    ]);
    await db.vendor.bulkPut([
      row({ id: "vendorA", name: "가상마트A", kind: "mart" }),
      row({ id: "vendorB", name: "가상마트B", kind: "mart" }),
    ]);
    await db.product.bulkPut([
      row({
        id: "p1",
        name: "위스키 술",
        category_id: "whisky",
        abv: "40.0",
        personal_rating: "5.0",
      }),
      row({
        id: "p2",
        name: "리큐르 술",
        category_id: "liquor",
        abv: "13.0",
        personal_rating: "3.0",
      }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 500 }),
      row({ id: "s2", product_id: "p2", volume_ml: 1000 }),
    ]);
    await db.purchase.bulkPut([
      row({
        id: "pu1",
        sku_id: "s1",
        vendor_id: "vendorA",
        quantity: 1,
        unit_list_price: "100000",
        unit_paid_price: "90000",
      }),
      row({
        id: "pu2",
        sku_id: "s2",
        vendor_id: "vendorB",
        quantity: 1,
        unit_list_price: "50000",
        unit_paid_price: "40000",
      }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "open", remaining_ml: 500 }),
    ]);
  }

  describe("getStatsRankings", () => {
    it("실구매가·정가 기준으로 내림차순 랭킹을 매긴다", async () => {
      await seedStatsFixture();

      const rankings = await getStatsRankings();

      expect(rankings.by_bottle_price.map((e) => e.product_id)).toEqual(["p1", "p2"]);
      expect(rankings.by_bottle_price[0]?.value).toBe("90000.00");
      expect(rankings.by_total_spend.map((e) => e.product_id)).toEqual(["p1", "p2"]);
      // 100ml당 가격은 정가 기준: p1 = 100000*100/500 = 20000, p2 = 50000*100/1000 = 5000.
      expect(rankings.by_price_per_100ml.map((e) => e.value)).toEqual(["20000.00", "5000.00"]);
      expect(rankings.by_personal_rating.map((e) => e.value)).toEqual(["5.0", "3.0"]);
    });
  });

  describe("getCategoryRollup", () => {
    it("하위 카테고리를 최상위 주종으로 롤업한다", async () => {
      await seedStatsFixture();

      const stats = await getCategoryRollup();

      expect(stats).toHaveLength(1);
      expect(stats[0]?.category_id).toBe("liquor");
      expect(stats[0]?.name).toBe("양주");
      expect(stats[0]?.bottle_count).toBe(2);
      expect(stats[0]?.total_spend).toBe("150000.00");
      expect(stats[0]?.avg_price_per_100ml).toBe("10000.00");
      expect(stats[0]?.discount_rate).toBe("0.1333");
    });

    it("카테고리가 없으면 미분류로 묶는다", async () => {
      await db.product.put(row({ id: "p1", name: "미분류 술", category_id: null }));

      const stats = await getCategoryRollup();

      expect(stats).toHaveLength(1);
      expect(stats[0]?.category_id).toBeNull();
      expect(stats[0]?.name).toBe("미분류");
    });
  });

  describe("getStatsSummary", () => {
    it("전체 합계와 재고·구매처 수를 계산한다", async () => {
      await seedStatsFixture();

      const summary = await getStatsSummary();

      expect(summary.purchased_count).toBe(2);
      expect(summary.in_stock_count).toBe(2);
      expect(summary.unopened_count).toBe(1);
      expect(summary.opened_count).toBe(1);
      expect(summary.list_total).toBe("150000.00");
      expect(summary.paid_total).toBe("130000.00");
      expect(summary.avg_list_price).toBe("75000.00");
      expect(summary.avg_personal_rating).toBe("4.0000");
      expect(summary.vendor_count).toBe(2);
    });
  });
});
