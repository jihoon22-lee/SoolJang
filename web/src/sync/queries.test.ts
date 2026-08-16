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

  it("purchased_on_min/max 범위 안에 구매가 하나라도 있으면 남긴다", async () => {
    await db.product.bulkPut([
      row({ id: "p1", name: "최근에 산 술" }),
      row({ id: "p2", name: "오래 전에 산 술" }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 500 }),
      row({ id: "s2", product_id: "p2", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({ id: "pu1", sku_id: "s1", purchased_on: "2024-06-01", quantity: 1 }),
      row({ id: "pu2", sku_id: "s2", purchased_on: "2020-01-01", quantity: 1 }),
    ]);

    expect((await getProducts({ purchased_on_min: "2024-01-01" })).map((p) => p.id)).toEqual([
      "p1",
    ]);
    expect((await getProducts({ purchased_on_max: "2020-12-31" })).map((p) => p.id)).toEqual([
      "p2",
    ]);
    expect(
      (await getProducts({ purchased_on_min: "2024-01-01", purchased_on_max: "2024-12-31" })).map(
        (p) => p.id,
      ),
    ).toEqual(["p1"]);
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

  it("같은 품종에 연결이 중복으로 남아 있어도 한 번만 센다", async () => {
    // 예전 백엔드 결함(hard delete 뒤 새 id 로 재생성)이 삭제를 로컬 미러에 전파하지
    // 못해, 이미 걸린 기기에는 같은 variety_id 를 가리키는 옛 연결이 그대로 남아 있을
    // 수 있다 — 재동기화 없이도 화면에서 바로 정상으로 보이려면 여기서 걸러야 한다.
    await db.product.put(row({ id: "p1", name: "중복 연결 테스트" }));
    await db.variety.put(row({ id: "v-레드", name: "레드" }));
    await db.product_variety.bulkPut([
      row({ id: "link-old", product_id: "p1", variety_id: "v-레드", sort_order: 0 }),
      row({ id: "link-new", product_id: "p1", variety_id: "v-레드", sort_order: 0 }),
    ]);

    const [product] = await getProducts({});

    expect(product?.varieties).toEqual(["레드"]);
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

  it("stockFirst 옵션은 미개봉 재고 > 개봉 재고만 > 재고 없음 순으로 묶고, 그룹 안에서는 정렬 키를 그대로 적용한다", async () => {
    // 이름 알파벳 순서(가-나-다)와 기대하는 티어 순서가 어긋나도록 일부러 고른다 —
    // 티어가 실제로 이름순보다 먼저 적용되는지 확인한다.
    await db.product.bulkPut([
      row({ id: "p-none", name: "가없음" }),
      row({ id: "p-open", name: "나개봉" }),
      row({ id: "p-unopened", name: "다미개봉" }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s-open", product_id: "p-open", volume_ml: 500 }),
      row({ id: "s-unopened", product_id: "p-unopened", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({ id: "pu-open", sku_id: "s-open", quantity: 1 }),
      row({ id: "pu-unopened", sku_id: "s-unopened", quantity: 1 }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b-open", purchase_id: "pu-open", label_no: 1, status: "open" }),
      row({ id: "b-unopened", purchase_id: "pu-unopened", label_no: 1, status: "unopened" }),
    ]);

    const stockFirst = await getProducts({ sort: "name", order: "asc" }, { stockFirst: true });
    expect(stockFirst.map((p) => p.id)).toEqual(["p-unopened", "p-open", "p-none"]);

    // 옵션이 꺼져 있으면(기본값) 순수 이름순으로, 재고 유무는 순서에 영향을 주지 않는다.
    const withoutOption = await getProducts({ sort: "name", order: "asc" });
    expect(withoutOption.map((p) => p.id)).toEqual(["p-none", "p-open", "p-unopened"]);
  });

  it("stockFirst 옵션은 내림차순에서도 티어 순서를 유지하고, 티어 안에서만 방향이 뒤집힌다", async () => {
    await db.product.bulkPut([
      row({ id: "p-unopened-a", name: "가미개봉" }),
      row({ id: "p-unopened-b", name: "나미개봉" }),
      row({ id: "p-none", name: "다없음" }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s-a", product_id: "p-unopened-a", volume_ml: 500 }),
      row({ id: "s-b", product_id: "p-unopened-b", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({ id: "pu-a", sku_id: "s-a", quantity: 1 }),
      row({ id: "pu-b", sku_id: "s-b", quantity: 1 }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b-a", purchase_id: "pu-a", label_no: 1, status: "unopened" }),
      row({ id: "b-b", purchase_id: "pu-b", label_no: 1, status: "unopened" }),
    ]);

    const descending = await getProducts({ sort: "name", order: "desc" }, { stockFirst: true });
    // 재고 없는 술이 맨 위로 오면 안 된다 — 미개봉 그룹이 여전히 먼저 나오고, 그
    // 그룹 안에서만 이름 내림차순(나미개봉 → 가미개봉)이 적용된다.
    expect(descending.map((p) => p.id)).toEqual(["p-unopened-b", "p-unopened-a", "p-none"]);
  });

  it("stockFirst 옵션은 이름이 아닌 다른 정렬 키에도 적용된다", async () => {
    await db.product.bulkPut([
      row({ id: "p-none", name: "없음", abv: "10.0" }),
      row({ id: "p-unopened", name: "미개봉", abv: "50.0" }),
    ]);
    await db.sku.put(row({ id: "s-unopened", product_id: "p-unopened", volume_ml: 500 }));
    await db.purchase.put(row({ id: "pu-unopened", sku_id: "s-unopened", quantity: 1 }));
    await db.bottle.put(
      row({ id: "b-unopened", purchase_id: "pu-unopened", label_no: 1, status: "unopened" }),
    );

    // 도수 오름차순만 보면 재고 없는 술(도수 10)이 먼저 와야 하지만, stockFirst 가
    // 켜져 있으면 재고 있는 술이 여전히 위에 남고 도수는 그룹 안에서만 적용된다.
    const result = await getProducts({ sort: "abv", order: "asc" }, { stockFirst: true });
    expect(result.map((p) => p.id)).toEqual(["p-unopened", "p-none"]);
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
      // 가성비 = 평점*1000/100ml당가격: p1 = 5*1000/20000 = 0.25, p2 = 3*1000/5000 = 0.6.
      // 평점은 p1 이 더 높지만 가격당으로 보면 p2 가 더 낫다 — 등수가 뒤집힌다.
      expect(rankings.by_value_for_money.map((e) => e.product_id)).toEqual(["p2", "p1"]);
      expect(rankings.by_value_for_money.map((e) => e.value)).toEqual(["0.60", "0.25"]);
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
      // 이 픽스처엔 증여·판매·소진 병이 없다 — 0건/null 로 정확히 비어 있어야 한다.
      expect(summary.gifted_count).toBe(0);
      expect(summary.sold_count).toBe(0);
      expect(summary.avg_days_to_finish).toBeNull();
      // (0.25 + 0.6) / 2 = 0.425
      expect(summary.avg_value_for_money).toBe("0.4250");
    });

    it("증여·판매 병수와 개봉→소진 평균 일수를 집계한다", async () => {
      await seedStatsFixture();
      // p1 의 병 하나를 소진 처리하고(9일 걸림), p2 의 병 하나를 증여로 내보낸다.
      await db.bottle.bulkPut([
        row({
          id: "b3",
          purchase_id: "pu1",
          label_no: 2,
          status: "finished",
          opened_on: "2026-01-01",
          finished_on: "2026-01-10",
          remaining_ml: 0,
        }),
        row({ id: "b4", purchase_id: "pu2", label_no: 2, status: "gifted", remaining_ml: null }),
      ]);

      const summary = await getStatsSummary();

      expect(summary.gifted_count).toBe(1);
      expect(summary.sold_count).toBe(0);
      expect(summary.avg_days_to_finish).toBe("9.00");
    });
  });
});
