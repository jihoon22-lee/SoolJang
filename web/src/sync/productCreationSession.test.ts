import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vendorsApi } from "@/api/client";
import { EMPTY_PRODUCT_FORM } from "@/components/ProductForm";
import { activateDatabase, db, type SoolJangDB } from "@/sync/db";
import * as outbox from "@/sync/outbox";
import { createProductOffline, resolveVendorId } from "@/sync/useCreateProduct";
import { captureWriteSession } from "@/sync/writeSession";

const stores = new Set<SoolJangDB>();

async function switchAccount(userId: string): Promise<void> {
  await activateDatabase(userId);
  stores.add(db);
}

beforeEach(async () => {
  await switchAccount("creation-session-owner-a");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) {
    await store.transaction("rw", store.tables, async () => {
      for (const table of store.tables) await table.clear();
    });
  }
  stores.clear();
});

it("구매처 목록을 기다리는 동안 계정이 바뀌면 새 계정에 구매처를 만들지 않는다", async () => {
  let respond!: (value: Awaited<ReturnType<typeof vendorsApi.list>>) => void;
  vi.spyOn(vendorsApi, "list").mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const create = vi.spyOn(vendorsApi, "create");
  const pending = resolveVendorId("A 계정의 합성 구매처", captureWriteSession());
  const rejected = expect(pending).rejects.toThrow("계정이 변경");

  await switchAccount("creation-session-owner-b");
  respond([]);

  await rejected;
  expect(create).not.toHaveBeenCalled();
});

it("구매처 생성 응답이 늦게 도착해도 바뀐 계정으로 결과를 넘기지 않는다", async () => {
  vi.spyOn(vendorsApi, "list").mockResolvedValue([]);
  let respond!: (value: Awaited<ReturnType<typeof vendorsApi.create>>) => void;
  const create = vi.spyOn(vendorsApi, "create").mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const pending = resolveVendorId("A 계정의 합성 구매처", captureWriteSession());
  const rejected = expect(pending).rejects.toThrow("계정이 변경");
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

  await switchAccount("creation-session-owner-b");
  respond({
    id: "vendor-a",
    name: "A 계정의 합성 구매처",
    kind: "other",
    url: null,
    note: null,
    purchase_count: 0,
    total_spend: null,
  });

  await rejected;
});

it("오프라인 구매 적재 직후 계정이 바뀌면 양쪽 저장소에 제품과 병을 남기지 않는다", async () => {
  const originalStore = db;
  const originalEnqueue = outbox.enqueue;
  vi.spyOn(outbox, "enqueue").mockImplementation(async (input) => {
    const result = await originalEnqueue(input);
    if (input.entity === "purchase") {
      await Dexie.waitFor(switchAccount("creation-session-owner-b"));
    }
    return result;
  });

  await expect(
    createProductOffline(
      { ...EMPTY_PRODUCT_FORM, name: "A의 합성 위스키", volumeMl: "700", quantity: "2" },
      "creation-session-owner-a",
    ),
  ).rejects.toThrow("계정이 변경");

  for (const store of [originalStore, db]) {
    expect(await store.product.count()).toBe(0);
    expect(await store.sku.count()).toBe(0);
    expect(await store.purchase.count()).toBe(0);
    expect(await store.bottle.count()).toBe(0);
    expect(await store.outbox.count()).toBe(0);
  }
});
