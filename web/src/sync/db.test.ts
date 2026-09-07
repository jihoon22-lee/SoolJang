import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/sync/db";

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  await db.transaction(
    "rw",
    [
      db.category,
      db.producer,
      db.variety,
      db.product,
      db.product_variety,
      db.sku,
      db.vendor,
      db.purchase,
      db.bottle,
      db.tasting_session,
      db.attachment,
      db.conflict_log,
      db.outbox,
      db.sync_meta,
    ],
    async () => {
      await Promise.all([
        db.category.clear(),
        db.producer.clear(),
        db.variety.clear(),
        db.product.clear(),
        db.product_variety.clear(),
        db.sku.clear(),
        db.vendor.clear(),
        db.purchase.clear(),
        db.bottle.clear(),
        db.tasting_session.clear(),
        db.attachment.clear(),
        db.conflict_log.clear(),
        db.outbox.clear(),
        db.sync_meta.clear(),
      ]);
    },
  );
});

describe("SoolJangDB", () => {
  it("모든 미러 테이블·outbox·sync_meta 를 열 수 있다", async () => {
    expect(db.isOpen()).toBe(true);
    expect(db.tables.map((t) => t.name).sort()).toEqual(
      [
        "attachment",
        "bottle",
        "category",
        "conflict_log",
        "outbox",
        "product",
        "product_variety",
        "producer",
        "purchase",
        "sku",
        "sync_meta",
        "tasting_session",
        "variety",
        "vendor",
      ].sort(),
    );
  });

  it("vendor 행을 쓰고 읽을 수 있다", async () => {
    await db.vendor.put({
      id: "v1",
      user_id: "u1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      name: "테스트 구매처",
    });

    const row = await db.vendor.get("v1");
    expect(row?.name).toBe("테스트 구매처");
  });

  it("outbox 항목을 쓰고 상태별로 조회할 수 있다", async () => {
    await db.outbox.put({
      idempotency_key: "op1",
      entity: "vendor",
      op: "create",
      entity_id: "v1",
      fields: { name: "구매처" },
      created_at: "2026-01-01T00:00:00Z",
      status: "pending",
      error: null,
    });

    const pending = await db.outbox.where("status").equals("pending").count();
    expect(pending).toBe(1);
  });
});

it("사용자별 미러와 outbox를 전환해도 이전 계정의 입력은 보존된다", async () => {
  const { activateDatabase, lockDatabase, databaseIdentity } = await import("@/sync/db");
  await activateDatabase("owner-a");
  await db.vendor.put({
    id: "private-a",
    user_id: "owner-a",
    name: "A의 구매처",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    deleted_at: null,
  });
  await db.outbox.put({
    idempotency_key: "a-key",
    user_id: "owner-a",
    entity: "vendor",
    entity_id: "private-a",
    op: "update",
    fields: { name: "A 변경" },
    created_at: "2026-01-02",
    status: "pending",
    error: null,
  });
  lockDatabase();
  expect(databaseIdentity().userId).toBeNull();
  await activateDatabase("owner-b");
  expect(await db.vendor.get("private-a")).toBeUndefined();
  expect(await db.outbox.count()).toBe(0);
  await activateDatabase("owner-a");
  expect((await db.vendor.get("private-a"))?.name).toBe("A의 구매처");
  expect(await db.outbox.count()).toBe(1);
});
it("구버전 소유권 미확인 대기열은 새 계정으로 자동 귀속하지 않는다", async () => {
  const { activateDatabase, SoolJangDB } = await import("@/sync/db");
  const legacy = new SoolJangDB();
  await legacy.outbox.put({
    idempotency_key: "unowned",
    entity: "vendor",
    entity_id: "missing",
    op: "create",
    fields: { name: "미확인" },
    created_at: "2026-01-01",
    status: "pending",
    error: null,
  });
  await activateDatabase("new-owner");
  expect(await db.outbox.get("unowned")).toBeUndefined();
  expect(await legacy.outbox.get("unowned")).toBeDefined();
  await legacy.outbox.delete("unowned");
  legacy.close();
});

it("첫 이전 뒤 구버전 탭에 생긴 새 키만 가져오며 성공한 키와 최신 미러를 되살리지 않는다", async () => {
  const { activateDatabase, importLegacyChanges, SoolJangDB } = await import("@/sync/db");
  const legacy = new SoolJangDB();
  const owner = "late-legacy-owner";
  const row = (id: string, name: string, updated = "2026-01-01") => ({
    id,
    user_id: owner,
    name,
    created_at: "2026-01-01",
    updated_at: updated,
    deleted_at: null,
  });
  const command = (key: string, id: string) => ({
    idempotency_key: key,
    entity: "vendor" as const,
    entity_id: id,
    op: "create" as const,
    fields: { name: id },
    created_at: "2026-01-01",
    status: "pending" as const,
    error: null,
  });
  await legacy.vendor.put(row("first", "구버전 값"));
  await legacy.outbox.put(command("already-applied", "first"));
  await activateDatabase(owner);
  expect(await db.outbox.get("already-applied")).toBeDefined();
  await db.outbox.delete("already-applied");
  await db.vendor.put(row("first", "새 버전에서 확정한 값", "2026-02-01"));
  await legacy.vendor.put(row("second", "늦게 만든 행"));
  await legacy.outbox.put(command("late-key", "second"));
  await activateDatabase(owner);
  expect(await db.outbox.get("already-applied")).toBeUndefined();
  expect(await db.outbox.get("late-key")).toMatchObject({ user_id: owner });
  expect((await db.vendor.get("first"))?.name).toBe("새 버전에서 확정한 값");
  expect((await db.vendor.get("second"))?.name).toBe("늦게 만든 행");
  await db.outbox.delete("late-key");
  await db.vendor.update("second", { name: "확정된 두 번째 값" });
  await Promise.all([importLegacyChanges(db, owner), importLegacyChanges(db, owner)]);
  expect(await db.outbox.count()).toBe(0);
  expect((await db.vendor.get("second"))?.name).toBe("확정된 두 번째 값");
  expect(await legacy.outbox.count()).toBe(2);
  await legacy.outbox.bulkDelete(["already-applied", "late-key"]);
  await legacy.vendor.bulkDelete(["first", "second"]);
  legacy.close();
});
