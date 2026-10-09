import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateDatabase, db, lockDatabase, type OutboxEntry, type SyncRow } from "@/sync/db";
import {
  exportQuarantine,
  listQuarantines,
  quarantineContext,
  quarantineInvalidEntries,
} from "@/sync/quarantine";

const OWNER = "quarantine-owner";
const NOW = "2026-10-09T00:00:00Z";

function entry(id: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    idempotency_key: `key-${id}`,
    sequence_key: `key-${id}`,
    entity_id: id,
    entity: "product",
    op: "create",
    user_id: "",
    fields: { name: "합성 제품" },
    created_at: NOW,
    status: "pending",
    error: null,
    ...overrides,
  };
}

function row(id: string, fields: Record<string, unknown> = {}): SyncRow {
  return {
    id,
    user_id: "",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...fields,
  };
}

beforeEach(async () => {
  await activateDatabase(OWNER);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await activateDatabase(OWNER);
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

it("소유자 없는 생성 체인을 원본 그대로 보관하고 독립적인 정상 명령은 유지한다", async () => {
  const originals = [
    entry("product"),
    entry("sku", { entity: "sku", user_id: OWNER, fields: { product_id: "product" } }),
    entry("purchase", {
      entity: "purchase",
      user_id: OWNER,
      fields: { sku_id: "sku", quantity: 1, bottle_ids: ["bottle"] },
    }),
  ];
  const normal = entry("normal", { user_id: OWNER });
  await db.outbox.bulkPut([...originals, normal]);
  const product = row("product");
  const sku = row("sku", { product_id: "product", user_id: OWNER });
  const purchase = row("purchase", { sku_id: "sku", user_id: OWNER });
  const bottle = row("bottle", { purchase_id: "purchase", user_id: OWNER });
  await db.product.put(product);
  await db.sku.put(sku);
  await db.purchase.put(purchase);
  await db.bottle.put(bottle);
  await db.sync_meta.put({ key: "cursor", value: "previous" });

  const context = quarantineContext();
  const results = await Promise.all([
    quarantineInvalidEntries(context),
    quarantineInvalidEntries(context),
  ]);
  expect(results.sort()).toEqual([0, 3]);
  expect(await db.outbox.toArray()).toEqual([normal]);
  expect(await db.product.get("product")).toBeUndefined();
  expect(await db.sku.count()).toBe(0);
  expect(await db.purchase.count()).toBe(0);
  expect(await db.bottle.count()).toBe(0);
  expect(await db.sync_meta.get("cursor")).toBeUndefined();
  const records = await listQuarantines(context);
  expect(records).toHaveLength(1);
  const exported = JSON.parse(await exportQuarantine(context, records[0]!.key));
  expect(exported.entries).toEqual(expect.arrayContaining(originals));
  expect(exported.rows).toEqual([
    { entity: "product", row: product },
    { entity: "sku", row: sku },
    { entity: "purchase", row: purchase },
    { entity: "bottle", row: bottle },
  ]);
});

it("다른 소유자가 명시된 원본은 보존하되 목록과 내보내기에 내용을 노출하지 않는다", async () => {
  const foreign = entry("foreign", {
    user_id: "another-account",
    fields: { name: "다른 계정의 비공개 입력" },
  });
  await db.outbox.bulkPut([foreign, entry("unknown")]);
  await db.product.bulkPut([
    row("foreign", { user_id: "another-account", name: "다른 계정의 비공개 입력" }),
    row("unknown"),
  ]);
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  const [summary] = await listQuarantines(context);
  expect(summary).toMatchObject({ count: 2, exportableCount: 1, unreadable: false });
  expect(JSON.stringify(summary)).not.toContain("another-account");
  const exported = await exportQuarantine(context, summary!.key);
  expect(exported).not.toContain("another-account");
  expect(exported).not.toContain("다른 계정의 비공개 입력");
  expect(JSON.parse((await db.sync_meta.get(summary!.key))!.value).entries).toContainEqual(foreign);
  expect(await db.product.count()).toBe(0);
});

it("모두 다른 소유자의 명령이면 내보내기를 거부한다", async () => {
  await db.outbox.put(entry("foreign", { user_id: "another-account" }));
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  const [summary] = await listQuarantines(context);
  expect(summary?.exportableCount).toBe(0);
  await expect(exportQuarantine(context, summary!.key)).rejects.toThrow("다른 계정의 기록");
});

it.each([
  "",
  undefined,
])("명령 소유자가 %s여도 대상 행이 다른 소유자이면 내보내지 않는다", async (owner) => {
  const secret = entry("foreign-target", {
    user_id: owner,
    fields: { name: "다른 소유자의 명령 비공개 내용" },
  });
  await db.outbox.bulkPut([secret, entry("safe-unknown")]);
  await db.product.put(row("foreign-target", { user_id: "another-account" }));
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  const [summary] = await listQuarantines(context);
  expect(summary).toMatchObject({ count: 2, exportableCount: 1 });
  const exported = await exportQuarantine(context, summary!.key);
  expect(JSON.parse(exported).entries).toEqual([entry("safe-unknown")]);
  expect(exported).not.toContain("다른 소유자의 명령 비공개 내용");
  expect(exported).not.toContain("foreign-target");
  expect(JSON.parse((await db.sync_meta.get(summary!.key))!.value).entries).toContainEqual(
    JSON.parse(JSON.stringify(secret)),
  );
});

it("소유자 없는 명령이 다른 소유자의 병도 건드리면 내보내기를 차단한다", async () => {
  await db.outbox.put(
    entry("tasting", {
      entity: "tasting_session",
      op: "action",
      action: "record_tasting",
      fields: { note: "다른 소유자의 시음 내용" },
      touched_ids: ["foreign-bottle"],
    }),
  );
  await db.bottle.put(row("foreign-bottle", { user_id: "another-account" }));
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  const [summary] = await listQuarantines(context);
  expect(summary?.exportableCount).toBe(0);
  await expect(exportQuarantine(context, summary!.key)).rejects.toThrow("다른 계정의 기록");
});

it("보관 대상 밖의 다른 소유자 부모와 그 후손 내용도 내보내지 않는다", async () => {
  await db.product.put(row("foreign-parent", { user_id: "another-account" }));
  await db.sku.put(row("sku-child", { product_id: "foreign-parent" }));
  await db.purchase.put(row("purchase-child", { sku_id: "sku-child", user_id: OWNER }));
  await db.outbox.bulkPut([
    entry("sku-child", {
      entity: "sku",
      fields: { product_id: "foreign-parent", note: "비공개 규격" },
    }),
    entry("purchase-child", {
      entity: "purchase",
      user_id: OWNER,
      fields: { sku_id: "sku-child", note: "비공개 구매" },
    }),
    entry("safe-unknown"),
  ]);
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  const [summary] = await listQuarantines(context);
  expect(summary).toMatchObject({ count: 3, exportableCount: 1 });
  const exported = await exportQuarantine(context, summary!.key);
  expect(exported).not.toContain("비공개");
  expect(JSON.parse(exported).rows).toEqual([]);
  expect(JSON.parse(exported).entries).toEqual([entry("safe-unknown")]);
});

it("격리 보존에 실패하면 원래 대기열·미러·커서를 모두 유지한다", async () => {
  const original = entry("product");
  const originalRow = row("product");
  await db.outbox.put(original);
  await db.product.put(originalRow);
  await db.sync_meta.put({ key: "cursor", value: "previous" });
  vi.spyOn(db.sync_meta, "add").mockRejectedValueOnce(new Error("합성 저장소 용량 오류"));

  await expect(quarantineInvalidEntries(quarantineContext())).rejects.toThrow("용량 오류");
  expect(await db.outbox.toArray()).toEqual([original]);
  expect(await db.product.get("product")).toEqual(originalRow);
  expect(await db.sync_meta.get("cursor")).toEqual({ key: "cursor", value: "previous" });
  expect(await listQuarantines(quarantineContext())).toEqual([]);
});

it("현재 계정의 기존 병에 준 영향은 원본 보존 후 서버 재조정 대상으로 남긴다", async () => {
  const bottle = row("bottle", { user_id: OWNER, status: "open", remaining_ml: 600 });
  const tasting = row("tasting", { bottle_id: "bottle" });
  await db.bottle.put(bottle);
  await db.tasting_session.put(tasting);
  await db.outbox.put(
    entry("tasting", {
      entity: "tasting_session",
      op: "action",
      action: "record_tasting",
      fields: { bottle_id: "bottle", poured_ml: 100 },
      touched_ids: ["bottle"],
    }),
  );
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  expect(await db.bottle.get("bottle")).toEqual(bottle);
  expect(await db.tasting_session.get("tasting")).toBeUndefined();
  expect(JSON.parse((await db.sync_meta.get("reconcile_ids"))!.value)).toContain("bottle");
  const [saved] = await listQuarantines(context);
  const exported = JSON.parse(await exportQuarantine(context, saved!.key));
  expect(exported.rows).toContainEqual({ entity: "bottle", row: bottle });
});

it("뒤늦게 들어온 격리 기록의 의존 명령도 자동 전송 대상으로 되돌리지 않는다", async () => {
  await db.outbox.put(entry("product"));
  await quarantineInvalidEntries(quarantineContext());
  const dependent = entry("sku", {
    entity: "sku",
    user_id: OWNER,
    fields: { product_id: "product" },
  });
  await db.outbox.put(dependent);
  expect(await quarantineInvalidEntries(quarantineContext())).toBe(1);
  expect(await db.outbox.count()).toBe(0);
  expect(await listQuarantines(quarantineContext())).toHaveLength(2);
});

it("손상된 격리 원본은 건드리지 않고 읽기 실패를 알린다", async () => {
  await db.sync_meta.put({ key: "quarantine:damaged", value: "{invalid" });
  await db.outbox.put(entry("product"));
  const context = quarantineContext();
  expect(await listQuarantines(context)).toEqual([
    { key: "quarantine:damaged", count: 0, exportableCount: 0, unreadable: true },
  ]);
  await expect(exportQuarantine(context, "quarantine:damaged")).rejects.toThrow("원본은 보존");
  await expect(quarantineInvalidEntries(context)).rejects.toThrow("원본과 대기열은 보존");
  expect(await db.outbox.count()).toBe(1);
  expect((await db.sync_meta.get("quarantine:damaged"))?.value).toBe("{invalid");
});

it("로그아웃하거나 계정이 바뀌면 이전 격리 기록을 읽거나 내보내지 않는다", async () => {
  await db.outbox.put(entry("product"));
  const context = quarantineContext();
  await quarantineInvalidEntries(context);
  const [saved] = await listQuarantines(context);
  lockDatabase();
  expect(() => quarantineContext()).toThrow("로그인 계정");
  await expect(exportQuarantine(context, saved!.key)).rejects.toThrow("계정이 변경");
  await activateDatabase("quarantine-other");
  await expect(listQuarantines(context)).rejects.toThrow("계정이 변경");
  await expect(quarantineInvalidEntries(context)).rejects.toThrow("계정이 변경");
});

it("원본을 쓰는 도중 로그아웃하면 격리와 삭제를 함께 롤백한다", async () => {
  const original = entry("product");
  await db.outbox.put(original);
  const context = quarantineContext();
  const add = db.sync_meta.add.bind(db.sync_meta);
  vi.spyOn(db.sync_meta, "add").mockImplementationOnce((...args) =>
    add(...args).then((result) => {
      lockDatabase();
      return result;
    }),
  );
  await expect(quarantineInvalidEntries(context)).rejects.toThrow("계정이 변경");
  expect(await context.store.outbox.toArray()).toEqual([original]);
  expect(await context.store.sync_meta.where("key").startsWith("quarantine:").count()).toBe(0);
});
