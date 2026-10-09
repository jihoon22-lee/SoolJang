import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmedBottleOperationKey, localBottleOperationKey } from "@/sync/bottleRevision";
import { activateDatabase, db } from "@/sync/db";
import { OUTBOX_CHANGED, syncEvents } from "@/sync/events";
import {
  discardAllFailedEntries,
  discardFailedEntry,
  enqueue,
  pendingEntityIds,
  replaceFailedEntry,
  retryFailedEntries,
} from "@/sync/outbox";

beforeEach(async () => {
  await activateDatabase("u1");
});

afterEach(async () => {
  await db.outbox.clear();
  await db.vendor.clear();
  await db.tasting_session.clear();
  await db.bottle.clear();
  await db.purchase.clear();
  await db.sku.clear();
  await db.product.clear();
  await db.sync_meta.clear();
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

  it("delete 의 cascadeDeletes 는 하위 행도 함께 soft delete 한다", async () => {
    const base = {
      user_id: "u1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
    };
    await db.product.put({ ...base, id: "p-del", name: "지울 술" });
    await db.sku.put({ ...base, id: "s-del", product_id: "p-del", volume_ml: 700 });
    await db.purchase.put({ ...base, id: "pu-del", sku_id: "s-del", quantity: 1 });
    await db.bottle.put({ ...base, id: "b-del", purchase_id: "pu-del", status: "unopened" });

    await enqueue({
      entity: "product",
      op: "delete",
      entityId: "p-del",
      fields: {},
      touchedIds: ["s-del", "pu-del", "b-del"],
      cascadeDeletes: [
        { entity: "sku", ids: ["s-del"] },
        { entity: "purchase", ids: ["pu-del"] },
        { entity: "bottle", ids: ["b-del"] },
      ],
    });

    expect((await db.bottle.get("b-del"))?.deleted_at).not.toBeNull();
    expect((await db.purchase.get("pu-del"))?.deleted_at).not.toBeNull();
    expect(await pendingEntityIds()).toEqual(new Set(["p-del", "s-del", "pu-del", "b-del"]));
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

it("실패한 부모만 폐기해서 뒤의 자식 참조를 깨뜨릴 수 없다", async () => {
  const parent = await enqueue({
    entity: "vendor",
    op: "create",
    entityId: "parent",
    fields: { name: "parent" },
  });
  const child = await enqueue({
    entity: "purchase",
    op: "create",
    entityId: "child",
    fields: { vendor_id: "parent" },
  });
  await db.outbox.update(parent, { status: "failed" });
  await expect(discardFailedEntry(parent)).rejects.toThrow("연결된");
  expect(await db.outbox.get(parent)).toBeDefined();
  expect(await db.outbox.get(child)).toBeDefined();
  await discardFailedEntry(parent, true);
  expect(await db.outbox.count()).toBe(0);
});
it("처리 결과가 미확인인 명령은 폐기하지 않는다", async () => {
  const key = await enqueue({
    entity: "vendor",
    op: "create",
    entityId: "unconfirmed",
    fields: {},
  });
  await expect(discardFailedEntry(key)).rejects.toThrow("확인되지 않은");
  expect(await db.outbox.get(key)).toBeDefined();
});

it("실패 명령을 수정하면 FIFO 위치와 대상은 보존하고 새 멱등 키를 발급한다", async () => {
  const oldKey = await enqueue({
    entity: "vendor",
    op: "create",
    entityId: "v-old",
    fields: { name: "old" },
  });
  const original = await db.outbox.get(oldKey);
  await db.outbox.update(oldKey, { status: "failed", error: "invalid" });
  const newKey = await replaceFailedEntry(oldKey, { name: "fixed" });
  const replacement = await db.outbox.get(newKey);
  expect(newKey).not.toBe(oldKey);
  expect(replacement?.created_at).toBe(original?.created_at);
  expect(replacement?.fields.name).toBe("fixed");
  expect(replacement?.status).toBe("pending");
  expect(await db.outbox.get(oldKey)).toBeUndefined();
});

it("실패한 병 명령 수정은 후속 undo의 receipt 참조만 바꾸고 순서와 최신 marker를 보존한다", async () => {
  const original = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "finish",
    fields: { finished_on: "2025-01-01" },
  });
  const undo = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "undo",
    fields: {
      origin_operation_id: original,
      expected_operation_id: original,
      note: original,
      metadata: { origin_operation_id: original },
    },
  });
  const foreign = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b2",
    action: "undo",
    fields: { expected_operation_id: original },
  });
  await db.sync_meta.put({ key: localBottleOperationKey("b1"), value: undo });
  const before = await db.outbox.get(original);
  const undoBefore = await db.outbox.get(undo);
  await db.outbox.update(original, { status: "failed", error: "소진일이 개봉일보다 앞섭니다" });

  const replacement = await replaceFailedEntry(original, { finished_on: "2026-10-01" });

  expect(await db.outbox.get(original)).toBeUndefined();
  expect(await db.outbox.get(replacement)).toMatchObject({
    sequence_key: before?.sequence_key,
    created_at: before?.created_at,
    status: "pending",
  });
  expect(await db.outbox.get(undo)).toEqual({
    ...undoBefore,
    fields: {
      origin_operation_id: replacement,
      expected_operation_id: replacement,
      note: original,
      metadata: { origin_operation_id: original },
    },
  });
  expect((await db.outbox.get(foreign))?.fields.expected_operation_id).toBe(original);
  expect((await db.sync_meta.get(localBottleOperationKey("b1")))?.value).toBe(undo);
});

it("실패한 시음 재시도는 후속 잔량 정정과 로컬 marker를 새 키로 연결한다", async () => {
  const tasting = await enqueue({
    entity: "tasting_session",
    op: "action",
    entityId: "t1",
    action: "record_tasting",
    fields: { bottle_id: "b1", tasted_on: "invalid" },
    touchedIds: ["b1"],
  });
  const remaining = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "set_remaining",
    fields: { expected_operation_id: tasting, remaining_ml: 350 },
  });
  await db.sync_meta.put({ key: localBottleOperationKey("b1"), value: tasting });
  await db.sync_meta.put({ key: confirmedBottleOperationKey("b1"), value: "confirmed receipt" });
  await db.outbox.update(tasting, { status: "failed" });

  const replacement = await replaceFailedEntry(tasting, {
    bottle_id: "b1",
    tasted_on: "2026-10-01",
  });

  expect((await db.outbox.get(remaining))?.fields).toEqual({
    expected_operation_id: replacement,
    remaining_ml: 350,
  });
  expect((await db.sync_meta.get(localBottleOperationKey("b1")))?.value).toBe(replacement);
  expect((await db.sync_meta.get(confirmedBottleOperationKey("b1")))?.value).toBe(
    "confirmed receipt",
  );
});

it("이미 실패 결과가 확정된 후속 명령과 결과 불명 부모는 자동으로 바꾸지 않는다", async () => {
  const parent = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "finish",
    fields: {},
  });
  const child = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "undo",
    fields: { origin_operation_id: parent },
  });
  await expect(replaceFailedEntry(parent, {})).rejects.toThrow("실패 명령");
  expect(await db.outbox.get(parent)).toBeDefined();
  await db.outbox.update(parent, { status: "failed" });
  await db.outbox.update(child, { status: "failed" });
  const before = await db.outbox.get(child);
  await replaceFailedEntry(parent, {});
  expect(await db.outbox.get(child)).toEqual(before);
});

it("marker 저장 실패 시 부모 교체와 후속 참조 갱신도 함께 롤백한다", async () => {
  const parent = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "finish",
    fields: {},
  });
  const child = await enqueue({
    entity: "bottle",
    op: "action",
    entityId: "b1",
    action: "undo",
    fields: { origin_operation_id: parent },
  });
  await db.outbox.update(parent, { status: "failed" });
  await db.sync_meta.put({ key: localBottleOperationKey("b1"), value: parent });
  const before = await db.outbox.toArray();
  const put = vi.spyOn(db.sync_meta, "put").mockRejectedValueOnce(new Error("storage failed"));
  try {
    await expect(replaceFailedEntry(parent, {})).rejects.toThrow("storage failed");
  } finally {
    put.mockRestore();
  }
  expect(await db.outbox.toArray()).toEqual(before);
  expect((await db.outbox.get(child))?.fields.origin_operation_id).toBe(parent);
  expect((await db.sync_meta.get(localBottleOperationKey("b1")))?.value).toBe(parent);
});

describe("실패 명령 일괄 처리", () => {
  it("모두 다시 보내기는 새 키의 대기 명령으로 바꾸고, 모두 건너뛰기는 의존 명령까지 버린다", async () => {
    const parent = await enqueue({ entity: "vendor", op: "create", entityId: "pv", fields: {} });
    await enqueue({
      entity: "purchase",
      op: "create",
      entityId: "child",
      fields: { vendor_id: "pv" },
    });
    await db.outbox.update(parent, { status: "failed", error: "이름이 필요합니다" });

    expect(await retryFailedEntries()).toBe(1);
    expect(await db.outbox.get(parent)).toBeUndefined();
    expect((await db.outbox.toArray()).every((entry) => entry.status === "pending")).toBe(true);

    const [retried] = (await db.outbox.toArray()).filter((entry) => entry.entity === "vendor");
    await db.outbox.update(retried?.idempotency_key as string, { status: "failed" });
    expect(await discardAllFailedEntries()).toBe(2);
    expect(await db.outbox.count()).toBe(0);
  });
});
