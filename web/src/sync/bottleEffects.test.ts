import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confirmedBottleOperation } from "@/sync/bottleRevision";
import { activateDatabase, db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";
import { enqueue } from "@/sync/outbox";
import { authenticatedRoutes, stubRoutes } from "@/testing";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: "u1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...extra,
});
const bottle = row("b1", {
  purchase_id: "pu1",
  status: "open",
  remaining_ml: 670,
  revision: "before",
});

beforeEach(async () => {
  await activateDatabase("u1");
  for (const table of db.tables) await table.clear();
  syncEngine.setUser("u1");
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
  await db.product.put(row("p1"));
  await db.sku.put(row("s1", { product_id: "p1", volume_ml: 700 }));
  await db.purchase.put(row("pu1", { sku_id: "s1" }));
  await db.bottle.put(bottle);
});
afterEach(() => {
  syncEngine.stop();
  vi.unstubAllGlobals();
});

async function tastingEntry() {
  return enqueue({
    entity: "tasting_session",
    op: "action",
    action: "record_tasting",
    entityId: "t1",
    fields: { bottle_id: "b1", sku_id: "s1" },
    touchedIds: ["b1"],
    optimisticRow: row("t1", { bottle_id: "b1", sku_id: "s1" }),
  });
}

it("시음 확인 응답은 병 revision을 함께 설치해 다음 잔량 정정의 기준이 된다", async () => {
  const operationId = await tastingEntry();
  stubRoutes([
    ...authenticatedRoutes(),
    {
      match: "/sync/batch",
      method: "POST",
      body: {
        stopped: false,
        results: [
          {
            idempotency_key: operationId,
            status: "applied",
            snapshot: row("t1"),
            effects: { bottle: { ...bottle, revision: "after-tasting" } },
          },
        ],
      },
    },
    { match: "/sync", body: { changes: {}, next_cursor: null, has_more: false } },
  ]);
  await syncEngine.triggerSync();
  expect((await db.bottle.get("b1"))?.revision).toBe("after-tasting");
  expect(await confirmedBottleOperation(db, "b1")).toEqual({
    operationId,
    revision: "after-tasting",
    status: "applied",
  });
  expect(await db.outbox.count()).toBe(0);
});

it.each([
  { id: "foreign-bottle", user_id: "u1" },
  { id: "b1", user_id: "other" },
])("잘못된 병 effect는 확인과 미러 반영을 함께 취소한다: %j", async (invalid) => {
  const operationId = await tastingEntry();
  stubRoutes([
    ...authenticatedRoutes(),
    {
      match: "/sync/batch",
      method: "POST",
      body: {
        stopped: false,
        results: [
          {
            idempotency_key: operationId,
            status: "applied",
            snapshot: row("t1"),
            effects: { bottle: { ...bottle, ...invalid, revision: "bad" } },
          },
        ],
      },
    },
    { match: "/sync", body: { changes: {}, next_cursor: null, has_more: false } },
  ]);
  await syncEngine.triggerSync();
  expect(await db.outbox.count()).toBe(1);
  expect((await db.bottle.get("b1"))?.revision).toBe("before");
  expect(await confirmedBottleOperation(db, "b1")).toBeNull();
});

it("응답을 기다리는 사이 새 병 명령이 생기면 이전 시음 effect가 낙관적 잔량을 덮지 않는다", async () => {
  const operationId = await tastingEntry();
  let batch = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/sync/batch")) {
        batch += 1;
        if (batch === 1) {
          await enqueue({
            entity: "bottle",
            op: "action",
            action: "set_remaining",
            entityId: "b1",
            fields: { remaining_ml: 600, expected_operation_id: operationId },
            optimisticRow: { ...bottle, remaining_ml: 600 },
          });
          return Response.json({
            stopped: false,
            results: [
              {
                idempotency_key: operationId,
                status: "applied",
                snapshot: row("t1"),
                effects: { bottle: { ...bottle, revision: "after-tasting" } },
              },
            ],
          });
        }
        const request = JSON.parse(String(init?.body));
        return Response.json({
          stopped: true,
          results: [
            {
              idempotency_key: request.operations[0].idempotency_key,
              status: "failed",
              snapshot: null,
              detail: "다시 확인",
            },
          ],
        });
      }
      return Response.json({ changes: {}, next_cursor: null, has_more: false });
    }),
  );
  await syncEngine.triggerSync();
  expect((await db.bottle.get("b1"))?.remaining_ml).toBe(600);
  expect((await confirmedBottleOperation(db, "b1"))?.revision).toBe("after-tasting");
  expect(await db.outbox.count()).toBe(1);
});
