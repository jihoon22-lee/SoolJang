import { beforeEach, expect, it, vi } from "vitest";
import { purchasesApi, tastingsApi } from "@/api/client";
import type {
  ContextualTasting,
  PurchaseCorrectionContext,
  PurchaseSkuCorrectionInput,
  TastingCorrectionInput,
} from "@/api/types";
import {
  getCorrectionBlockReason,
  submitPurchaseSkuCorrection,
  submitTastingCorrection,
} from "@/sync/corrections";
import { activateDatabase, db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";
import { captureWriteSession } from "@/sync/writeSession";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "correction-owner",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...fields,
});
const input: TastingCorrectionInput = {
  request_id: "request",
  expected_updated_at: "2026-01-01T00:00:00Z",
  changes: { bottle_id: "b1", sku_id: "s1" },
  expected_bottles: [{ id: "b1", revision: "rev" }],
  remaining_mode: "preserve",
  final_bottles: [],
};
const purchaseInput: PurchaseSkuCorrectionInput = {
  request_id: "purchase-request",
  expected_updated_at: input.expected_updated_at,
  target_sku_id: "s2",
  target_sku_expected_volume_ml: 750,
  expected_bottles: input.expected_bottles,
  expected_tastings: [{ id: "t1", updated_at: input.expected_updated_at }],
  final_bottles: [],
};
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(syncEngine, "triggerSync").mockResolvedValue();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await activateDatabase("correction-owner");
  for (const table of db.tables) await table.clear();
  await db.sku.put(row("s1", { product_id: "p1" }));
  await db.purchase.put(row("q1", { sku_id: "s1" }));
  await db.bottle.put(row("b1", { purchase_id: "q1", remaining_ml: 410 }));
  await db.tasting_session.put(row("t1", { sku_id: "s1", bottle_id: "b1", note: "현재 노트" }));
});
async function queue(
  entityId: string,
  status: "pending" | "failed",
  fields: Record<string, unknown> = {},
  touchedIds?: string[],
) {
  await db.outbox.put({
    idempotency_key: "queued",
    entity: "tasting_session",
    entity_id: entityId,
    op: "update",
    fields,
    status,
    error: status === "failed" ? "충돌" : null,
    created_at: "2026-01-01",
    ...(touchedIds ? { touched_ids: touchedIds } : {}),
  });
}
it.each([
  "pending",
  "failed",
] as const)("%s 명령이 관련 병을 건드리면 정정을 보내지 않는다", async (status) => {
  const send = vi.spyOn(tastingsApi, "correct");
  await queue("new-tasting", status, {}, ["b1"]);
  await expect(submitTastingCorrection("t1", input, captureWriteSession())).rejects.toThrow(
    "동기화 대기 또는 실패",
  );
  expect(send).not.toHaveBeenCalled();
});
it("부모 변경과 아직 서버에 없는 자식 참조도 확인하고 영향 밖 명령은 허용한다", async () => {
  const session = captureWriteSession();
  await queue("p1", "pending");
  expect(await getCorrectionBlockReason(session, ["t1"])).toContain("동기화");
  await queue("new-tasting", "pending", { bottle_id: "b1" });
  expect(await getCorrectionBlockReason(session, ["t1"])).toContain("동기화");
  await queue("unrelated", "failed", { bottle_id: "other-bottle" });
  expect(await getCorrectionBlockReason(session, ["t1"])).toBeNull();
});
it("재요청의 오래된 응답을 미러에 덮지 않고 pull을 요청한다", async () => {
  const old = { id: "t1", note: "과거 노트" } as ContextualTasting;
  const send = vi.spyOn(tastingsApi, "correct").mockResolvedValue(old);
  expect(await submitTastingCorrection("t1", input, captureWriteSession())).toBe(old);
  expect(send).toHaveBeenCalledWith("t1", input);
  expect((await db.tasting_session.get("t1"))?.note).toBe("현재 노트");
  expect((await db.bottle.get("b1"))?.remaining_ml).toBe(410);
  expect(syncEngine.triggerSync).toHaveBeenCalledOnce();
});
it("같은 SKU의 다른 병에 남은 시음은 이 병 정정을 막지 않는다", async () => {
  await queue("other-tasting", "pending", { sku_id: "s1", bottle_id: "b2" }, ["b2"]);
  expect(await getCorrectionBlockReason(captureWriteSession(), ["t1", "b1", "s1"])).toBeNull();
  await queue("other-tasting", "pending", { sku_id: "s1", bottle_id: "b1" }, ["b1"]);
  expect(await getCorrectionBlockReason(captureWriteSession(), ["t1", "b1", "s1"])).toContain(
    "동기화",
  );
});
it("구매 정정도 관련 시음을 검사하고 성공 뒤에만 동기화를 요청한다", async () => {
  const send = vi
    .spyOn(purchasesApi, "correctSku")
    .mockResolvedValue({} as PurchaseCorrectionContext);
  await queue("t1", "failed");
  await expect(
    submitPurchaseSkuCorrection("q1", purchaseInput, captureWriteSession()),
  ).rejects.toThrow("동기화");
  expect(send).not.toHaveBeenCalled();
  await db.outbox.clear();
  await submitPurchaseSkuCorrection("q1", purchaseInput, captureWriteSession());
  expect(syncEngine.triggerSync).toHaveBeenCalledOnce();
  expect((await db.purchase.get("q1"))?.sku_id).toBe("s1");
});
it("오프라인과 계정 변경 후에는 요청하지 않는다", async () => {
  const send = vi.spyOn(tastingsApi, "correct");
  const session = captureWriteSession();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await expect(submitTastingCorrection("t1", input, session)).rejects.toThrow("온라인");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await activateDatabase("another-owner");
  await expect(submitTastingCorrection("t1", input, session)).rejects.toThrow("계정이 변경");
  expect(send).not.toHaveBeenCalled();
});
it("저장 응답이 늦게 와도 바뀐 계정의 동기화를 시작하지 않는다", async () => {
  let complete!: (value: ContextualTasting) => void;
  const send = vi.spyOn(tastingsApi, "correct").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = submitTastingCorrection("t1", input, captureWriteSession());
  while (!send.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0));
  await activateDatabase("another-owner");
  const rejected = expect(pending).rejects.toThrow("계정이 변경");
  complete({ id: "t1" } as ContextualTasting);
  await rejected;
  expect(syncEngine.triggerSync).not.toHaveBeenCalled();
});
