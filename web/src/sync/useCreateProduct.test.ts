import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_PRODUCT_FORM } from "@/components/ProductForm";
import { activateDatabase, db } from "@/sync/db";
import { getProducts } from "@/sync/queries";
import { createProductOffline } from "@/sync/useCreateProduct";

beforeEach(async () => {
  await activateDatabase("chain-owner");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});
it("오프라인 제품·규격·구매·병 생성 체인은 한 번에 커밋된다", async () => {
  await createProductOffline(
    {
      ...EMPTY_PRODUCT_FORM,
      name: "합성 위스키",
      volumeMl: "700",
      quantity: "2",
      unitPaidPrice: "0",
    },
    "chain-owner",
  );
  expect(await db.product.count()).toBe(1);
  expect(await db.sku.count()).toBe(1);
  expect(await db.purchase.count()).toBe(1);
  expect(await db.bottle.count()).toBe(2);
  const entries = await db.outbox.orderBy("created_at").toArray();
  expect(entries.map((entry) => entry.entity)).toEqual(["product", "sku", "purchase"]);
  expect(entries.every((entry) => entry.user_id === "chain-owner")).toBe(true);
  expect((await db.purchase.toArray())[0]?.unit_paid_price).toBe("0");
});
it("체인 마지막 로컬 저장이 실패하면 앞의 제품과 대기열도 롤백한다", async () => {
  vi.spyOn(db.bottle, "bulkPut").mockRejectedValueOnce(new Error("fixture storage failure"));
  await expect(
    createProductOffline(
      { ...EMPTY_PRODUCT_FORM, name: "합성 위스키", volumeMl: "700", quantity: "2" },
      "chain-owner",
    ),
  ).rejects.toThrow("fixture storage failure");
  expect(await db.product.count()).toBe(0);
  expect(await db.purchase.count()).toBe(0);
  expect(await db.outbox.count()).toBe(0);
});

it("오프라인 원어명·별칭은 미러 검색과 보낼 등록 요청에 함께 남는다", async () => {
  await createProductOffline(
    {
      ...EMPTY_PRODUCT_FORM,
      name: "GlenAllachie 12",
      nameEn: "The GlenAllachie",
      searchAliases: "내 셰리, 우리집 위스키",
    },
    "chain-owner",
  );
  const [entry] = await db.outbox.toArray();
  expect(entry?.fields).toMatchObject({
    name_en: "The GlenAllachie",
    search_aliases: ["내 셰리", "우리집 위스키"],
  });
  expect((await getProducts({ q: "우리집" })).map((product) => product.name)).toEqual([
    "GlenAllachie 12",
  ]);
});
