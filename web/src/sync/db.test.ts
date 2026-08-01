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
