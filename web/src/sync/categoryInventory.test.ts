import { afterEach, expect, it } from "vitest";
import { db } from "@/sync/db";
import { getCategoryRollup } from "@/sync/queries";
import fixture from "../../../tests/fixtures/category_inventory_cases.json";

const stamp = "2026-10-11T00:00:00Z";
const row = (data: Record<string, unknown>) => ({
  id: "",
  user_id: "u",
  created_at: stamp,
  updated_at: stamp,
  deleted_at: null,
  ...data,
});
afterEach(() => db.delete());
it("상태별 현재 병수와 누적 구매를 같은 정답으로 집계한다", async () => {
  await db.open();
  await db.category.bulkPut([
    row({ id: "root", name: "상위", parent_id: null }),
    row({ id: "child", name: "하위", parent_id: "root" }),
  ]);
  await db.product.bulkPut([
    row({ id: "p", name: "다중규격", category_id: "child" }),
    row({ id: "q", name: "미지정", category_id: null }),
  ]);
  for (const [i, lot] of fixture.lots.entries()) {
    await db.sku.put(
      row({ id: `s${i}`, product_id: lot.category ? "p" : "q", volume_ml: lot.volume }),
    );
    await db.purchase.put(
      row({
        id: `buy${i}`,
        sku_id: `s${i}`,
        quantity: lot.states.length,
        unit_paid_price: "10000",
      }),
    );
    for (const [j, status] of lot.states.entries())
      await db.bottle.put(
        row({ id: `b${i}-${j}`, purchase_id: `buy${i}`, status, label_no: j + 1 }),
      );
  }
  const stats = await getCategoryRollup();
  expect(stats.find((s) => s.category_id === "root")).toMatchObject(fixture.expected.root);
  expect(stats.find((s) => s.category_id === null)).toMatchObject(fixture.expected.uncategorized);
  const detailed = await getCategoryRollup(undefined, undefined, true);
  expect(detailed.find((s) => s.category_id === "child")).toMatchObject({
    ...fixture.expected.root,
    parent_category_id: "root",
  });
});
