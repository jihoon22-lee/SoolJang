import { describe, expect, it } from "vitest";
import type { Product, ProductMetrics } from "@/api/types";
import {
  productEdition,
  productSkuSummaries,
  purchaseReference,
  skuHistoryLabel,
} from "@/components/productDisplay";

describe("제품과 구매 식별", () => {
  it("동일 이름의 판본을 빈티지·숙성연수·도수로 구분한다", () => {
    expect(productEdition({ vintage: 2020, age_years: "12.0", abv: "46.00" })).toBe(
      "2020 빈티지 · 12년 숙성 · 46%",
    );
    expect(productEdition({ vintage: null, age_years: null, abv: null })).toBe("");
  });
  it("맥락이 같은 구매가 하나뿐이면 내부 참조를 붙이지 않는다", () => {
    const only = { id: "p1", volumeMl: 700, purchasedOn: "2026-08-04", vendorName: "가상마트" };
    expect(purchaseReference(only, [only])).toBeNull();
    // 용량·날짜·구매처 중 하나라도 다르면 사람이 읽는 맥락으로 구분된다.
    const otherDay = { ...only, id: "p2", purchasedOn: "2026-09-01" };
    const otherVendor = { ...only, id: "p3", vendorName: "가상면세점" };
    const otherVolume = { ...only, id: "p4", volumeMl: 375 };
    const all = [only, otherDay, otherVendor, otherVolume];
    expect(all.map((purchase) => purchaseReference(purchase, all))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
  it("맥락이 겹치는 구매끼리만 서로 다른 참조를 만든다", () => {
    const ids = ["00000000-0000-4000-8000-0001abcd1234", "00000000-0000-4000-8000-0002abcd1234"];
    const same = { volumeMl: 700, purchasedOn: null, vendorName: null };
    const [one, two] = ids.map((id) => ({ id, ...same }));
    if (!one || !two) throw new Error("구매 준비 실패");
    const purchases = [one, two];
    const first = purchaseReference(one, purchases);
    const second = purchaseReference(two, purchases);
    expect(first).toMatch(/^구매 /);
    expect(first).not.toBe(second);
    // 다른 제품의 같은 맥락 구매와는 겹치지 않는다(제품 이름이 이미 구분한다).
    const ownProduct = { id: "a", productId: "x", ...same };
    const otherProduct = [ownProduct, { id: "b", productId: "y", ...same }];
    expect(purchaseReference(ownProduct, otherProduct)).toBeNull();
    expect(purchaseReference({ id: "short", ...same }, [{ id: "short", ...same }])).toBeNull();
  });
  it("단일 SKU의 구응답만 제품 집계를 재사용한다", () => {
    const metrics = {
      avg_paid_price: "0",
      purchased_count: 1,
      in_stock_count: 1,
    } as ProductMetrics;
    const product = { skus: [{ id: "single", volume_ml: 700 }], metrics } as Product;
    expect(productSkuSummaries(product)).toEqual([{ sku_id: "single", volume_ml: 700, metrics }]);
    expect(
      productSkuSummaries({
        ...product,
        skus: [
          ...product.skus,
          { ...product.skus[0], id: "other", volume_ml: 350 } as Product["skus"][number],
        ],
      }),
    ).toBeNull();
    expect(productSkuSummaries({ ...product, skus: [] })).toEqual([]);
  });
  it("0원 구매와 구매 없는 규격은 가격의 참거짓으로 구분하지 않는다", () => {
    expect(
      skuHistoryLabel({
        purchased_count: 1,
        in_stock_count: 0,
        avg_paid_price: "0",
      } as ProductMetrics),
    ).toBe("지난 규격");
    expect(
      skuHistoryLabel({
        purchased_count: 0,
        in_stock_count: 0,
        avg_paid_price: null,
      } as ProductMetrics),
    ).toBe("구매 기록 없음");
  });
});
