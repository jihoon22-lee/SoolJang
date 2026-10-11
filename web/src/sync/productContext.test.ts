import { beforeEach, expect, it } from "vitest";
import { activateDatabase, db } from "@/sync/db";
import { resolveProductContext } from "@/sync/productContext";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "context-user",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...fields,
});
beforeEach(async () => {
  await activateDatabase("context-user");
  for (const table of db.tables) await table.clear();
  await db.product.put(row("p"));
  await db.sku.put(row("s", { product_id: "p" }));
  await db.purchase.put(row("purchase", { sku_id: "s" }));
  await db.bottle.put(row("b", { purchase_id: "purchase" }));
  await db.tasting_session.put(row("t", { sku_id: "s", bottle_id: "b" }));
});
it("최근 시음 ID만으로 원래 SKU·병 연결을 복원한다", async () => {
  expect(await resolveProductContext("p", { tastingId: "t" })).toEqual({
    skuId: "s",
    bottleId: "b",
    tastingId: "t",
  });
});
it("제품이나 명시한 병이 다르면 다른 대상으로 대체하지 않는다", async () => {
  expect(await resolveProductContext("other", { bottleId: "b" })).toBeNull();
  expect(await resolveProductContext("p", { tastingId: "t", bottleId: "other" })).toBeNull();
});
it("삭제된 구매와 타 계정 SKU는 조회 맥락에서 거부한다", async () => {
  await db.purchase.update("purchase", { deleted_at: "2026-01-02" });
  expect(await resolveProductContext("p", { bottleId: "b" })).toBeNull();
  await db.sku.update("s", { user_id: "other" });
  expect(await resolveProductContext("p", { skuId: "s" })).toBeNull();
});
it("시음·병·규격 누락도 명확히 거부하고 전체 보기는 유지한다", async () => {
  for (const context of [{ tastingId: "absent" }, { bottleId: "absent" }, { skuId: "absent" }])
    expect(await resolveProductContext("p", context)).toBeNull();
  expect(await resolveProductContext("p", {})).toEqual({});
});

it("구매 근거만으로 규격을 복원하고 다른 병·계정·규격의 구매를 대신 보여주지 않는다", async () => {
  expect(await resolveProductContext("p", { purchaseId: "purchase" })).toMatchObject({
    skuId: "s",
    purchaseId: "purchase",
  });
  await db.purchase.put(row("other", { sku_id: "s" }));
  expect(await resolveProductContext("p", { purchaseId: "other", bottleId: "b" })).toBeNull();
  expect(
    await resolveProductContext("p", { purchaseId: "purchase", skuId: "different" }),
  ).toBeNull();
  await db.purchase.update("purchase", { user_id: "other-account" });
  expect(await resolveProductContext("p", { purchaseId: "purchase" })).toBeNull();
});
