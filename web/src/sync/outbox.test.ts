import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/sync/db";
import { OUTBOX_CHANGED, syncEvents } from "@/sync/events";
import { enqueue, pendingEntityIds } from "@/sync/outbox";

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  await db.outbox.clear();
  await db.vendor.clear();
});

describe("enqueue", () => {
  it("outbox 항목을 적재하고 낙관적 행을 반영한다", async () => {
    const listener = vi.fn();
    syncEvents.addEventListener(OUTBOX_CHANGED, listener);

    const key = await enqueue({
      entity: "vendor",
      op: "create",
      entityId: "v1",
      fields: { name: "낙관적 구매처" },
      optimisticRow: {
        id: "v1",
        user_id: "u1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        name: "낙관적 구매처",
      },
    });

    syncEvents.removeEventListener(OUTBOX_CHANGED, listener);

    const outboxEntry = await db.outbox.get(key);
    expect(outboxEntry?.status).toBe("pending");

    const vendorRow = await db.vendor.get("v1");
    expect(vendorRow?.name).toBe("낙관적 구매처");

    expect(listener).toHaveBeenCalledOnce();
  });

  it("delete 는 낙관적 행의 deleted_at 만 채운다", async () => {
    await db.vendor.put({
      id: "v2",
      user_id: "u1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      name: "삭제 예정",
    });

    await enqueue({ entity: "vendor", op: "delete", entityId: "v2", fields: {} });

    const row = await db.vendor.get("v2");
    expect(row?.deleted_at).not.toBeNull();
  });

  it("pendingEntityIds 는 아직 전송되지 않은 대상 id 를 모은다", async () => {
    await enqueue({ entity: "vendor", op: "create", entityId: "v3", fields: { name: "A" } });
    await enqueue({ entity: "vendor", op: "update", entityId: "v3", fields: { name: "B" } });

    const ids = await pendingEntityIds();
    expect(ids.has("v3")).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("pendingEntityIds 는 touchedIds(부작용으로 건드리는 다른 엔티티)도 포함한다", async () => {
    await enqueue({
      entity: "tasting_session",
      op: "action",
      entityId: "t1",
      action: "record_tasting",
      fields: {},
      touchedIds: ["bottle1"],
    });

    const ids = await pendingEntityIds();
    expect(ids.has("t1")).toBe(true);
    expect(ids.has("bottle1")).toBe(true);
    expect(ids.size).toBe(2);
  });
});
