import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/sync/db";
import { OUTBOX_CHANGED, syncEvents } from "@/sync/events";
import { discardFailedEntry, enqueue, pendingEntityIds } from "@/sync/outbox";

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  await db.outbox.clear();
  await db.vendor.clear();
  await db.tasting_session.clear();
  await db.bottle.clear();
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

describe("discardFailedEntry", () => {
  it("실패한 create 항목을 지우면 로컬에 남은 낙관적 행도 함께 지운다", async () => {
    const key = await enqueue({
      entity: "vendor",
      op: "create",
      entityId: "v9",
      fields: { name: "실패할 구매처" },
      optimisticRow: {
        id: "v9",
        user_id: "u1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        name: "실패할 구매처",
      },
    });
    await db.outbox.update(key, { status: "failed", error: "이미 존재합니다" });

    await discardFailedEntry(key);

    expect(await db.outbox.get(key)).toBeUndefined();
    expect(await db.vendor.get("v9")).toBeUndefined();
  });

  it("실패한 update 항목을 지워도 기존 엔티티 행은 남긴다 — 다음 풀이 되돌린다", async () => {
    await db.vendor.put({
      id: "v10",
      user_id: "u1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      name: "원래 이름",
    });
    const key = await enqueue({
      entity: "vendor",
      op: "update",
      entityId: "v10",
      fields: { name: "바꾸려던 이름" },
      optimisticRow: {
        id: "v10",
        user_id: "u1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        name: "바꾸려던 이름",
      },
    });
    await db.outbox.update(key, { status: "failed", error: "이름이 너무 깁니다" });

    await discardFailedEntry(key);

    expect(await db.outbox.get(key)).toBeUndefined();
    // 낙관적으로 덮어쓴 값이 남아 있다 — outbox 에서 빠졌으니 다음 풀이 서버 값으로 되돌린다.
    expect(await db.vendor.get("v10")).not.toBeUndefined();
  });

  it("tasting_session 의 action 은 create 가 아니어도 낙관적 행을 함께 지운다", async () => {
    const key = await enqueue({
      entity: "tasting_session",
      op: "action",
      entityId: "t9",
      action: "record_tasting",
      fields: { bottle_id: "b1", sku_id: "sku1", tasted_on: "2026-01-01" },
      optimisticRow: {
        id: "t9",
        user_id: "u1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        bottle_id: "b1",
        sku_id: "sku1",
        tasted_on: "2026-01-01",
      },
      touchedIds: ["b1"],
    });
    await db.outbox.update(key, { status: "failed", error: "잔량이 부족합니다" });

    await discardFailedEntry(key);

    expect(await db.outbox.get(key)).toBeUndefined();
    expect(await db.tasting_session.get("t9")).toBeUndefined();
  });

  it("이미 없는 항목을 건너뛰려 해도 조용히 아무 일도 하지 않는다", async () => {
    await expect(discardFailedEntry("no-such-key")).resolves.toBeUndefined();
  });
});
