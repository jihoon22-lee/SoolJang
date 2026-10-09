import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import { computeProductMetrics } from "@/domain/metrics";
import { activateDatabase, db } from "@/sync/db";
import { getProduct, getStatsSummary, serializeMetrics } from "@/sync/queries";
import fixture from "../../../tests/fixtures/metrics_cases.json";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "sku-test",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...fields,
});
beforeEach(async () => {
  await activateDatabase("sku-test");
  for (const table of db.tables) await table.clear();
});

describe("SKU별 원가 공유 정답: 순수 계산·로컬 목록·전체 합계", () => {
  it.each(fixture.product_metrics_cases)("$name", async (testCase) => {
    const skuById = new Map(testCase.skus.map((sku) => [sku.sku_id, sku]));
    const lots = testCase.lots.map((lot) => ({
      purchaseId: lot.purchase_id,
      skuId: lot.sku_id,
      quantity: lot.quantity,
      volumeMl: skuById.get(lot.sku_id)?.volume_ml ?? 0,
      unitListPrice: lot.unit_list_price === null ? null : new Decimal(lot.unit_list_price),
      unitPaidPrice: lot.unit_paid_price === null ? null : new Decimal(lot.unit_paid_price),
    }));
    const bottles = testCase.bottles.map((bottle) => ({
      purchaseId: bottle.purchase_id,
      status: bottle.status,
      openedOn: null,
      finishedOn: null,
    }));
    expect(serializeMetrics(computeProductMetrics(lots, bottles))).toMatchObject(
      testCase.expected.metrics,
    );
    await db.product.put(row("product", { name: "합성 제품" }));
    await db.sku.bulkPut(
      testCase.skus.map((sku) =>
        row(sku.sku_id, { product_id: "product", volume_ml: sku.volume_ml }),
      ),
    );
    await db.purchase.bulkPut(testCase.lots.map((lot) => row(lot.purchase_id, { ...lot })));
    await db.bottle.bulkPut(testCase.bottles.map((bottle) => row(bottle.bottle_id, { ...bottle })));
    const product = await getProduct("product");
    expect(product?.metrics).toMatchObject(testCase.expected.metrics);
    expect(product?.sku_summaries).toHaveLength(testCase.expected.sku_summaries.length);
    testCase.expected.sku_summaries.forEach((expected, index) => {
      expect(product?.sku_summaries?.[index]).toMatchObject(expected);
    });
    expect((await getStatsSummary()).inventory_value_at_cost).toBe(
      testCase.expected.metrics.inventory_value_at_cost,
    );
  });
  it("연결 없는 다중 규격은 제품 평균으로 원가를 꾸미지 않는다", () => {
    expect(() =>
      computeProductMetrics(
        [
          { quantity: 1, volumeMl: 500, unitListPrice: null, unitPaidPrice: null },
          { quantity: 1, volumeMl: 750, unitListPrice: null, unitPaidPrice: null },
        ],
        [],
      ),
    ).toThrow("구매·SKU 연결");
  });
  it("부분 연결 누락은 안전하게 거부한다", () => {
    expect(() =>
      computeProductMetrics(
        [
          {
            purchaseId: "p",
            skuId: "s",
            quantity: 1,
            volumeMl: 500,
            unitListPrice: null,
            unitPaidPrice: null,
          },
        ],
        [{ status: "open", openedOn: null, finishedOn: null }],
      ),
    ).toThrow("병의 구매 연결");
  });
});
