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
  it("같은 UUID 끝자리인 반복 구매에도 서로 다른 참조를 만든다", () => {
    const ids = ["00000000-0000-4000-8000-0001abcd1234", "00000000-0000-4000-8000-0002abcd1234"];
    expect(purchaseReference(ids[0] as string, ids)).not.toBe(
      purchaseReference(ids[1] as string, ids),
    );
    expect(purchaseReference("short", ["short"])).toBe("구매 short");
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
