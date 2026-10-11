import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadInsightSnapshot } from "@/insights/load";
import { activateDatabase, db } from "@/sync/db";

beforeEach(async () => {
  await activateDatabase("insight-owner");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});
it("현재 계정의 살아 있는 원본만 하나의 스냅샷으로 읽는다", async () => {
  const base = { created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null };
  await db.product.bulkPut([
    { ...base, id: "own", user_id: "insight-owner", name: "내 제품" },
    { ...base, id: "other", user_id: "other", name: "다른 계정" },
    { ...base, id: "deleted", user_id: "insight-owner", deleted_at: "2026-01-01" },
  ]);
  const result = await loadInsightSnapshot();
  expect(result.snapshot.products.map((x) => x.id)).toEqual(["own"]);
});
it("조회 도중 계정이 바뀌면 이전 계정의 결과를 반환하지 않는다", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const store = db;
  const original = store.product.toArray.bind(store.product);
  vi.spyOn(store.product, "toArray").mockImplementation((thenShortcut) => {
    enter();
    return Dexie.Promise.resolve(Dexie.waitFor(gate))
      .then(() => original())
      .then(thenShortcut);
  });
  const load = loadInsightSnapshot();
  await entered;
  await activateDatabase("other-insight-owner");
  release();
  await expect(load).rejects.toThrow(/계정/);
});
