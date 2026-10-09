import { purchasesApi, tastingsApi } from "@/api/client";
import type { PurchaseSkuCorrectionInput, TastingCorrectionInput } from "@/api/types";
import type { SyncRow } from "@/sync/db";
import { syncEngine } from "@/sync/engine";
import type { WriteSession } from "@/sync/writeSession";

/** 확인한 행과 그 부모의 미전송 변경을 검사한다. 실패한 명령도 아직 해결된 변경이 아니다. */
export async function getCorrectionBlockReason(
  session: WriteSession,
  affectedIds: readonly string[],
): Promise<string | null> {
  session.assertCurrent();
  const store = session.store;
  const blocked = await store.transaction(
    "r",
    [store.outbox, store.tasting_session, store.bottle, store.purchase, store.sku],
    async () => {
      const directIds = new Set(affectedIds);
      const ids = new Set(affectedIds);
      const addReferences = (rows: (SyncRow | undefined)[], fields: string[]) => {
        for (const row of rows)
          if (row && row.user_id === session.userId)
            for (const field of fields) if (typeof row[field] === "string") ids.add(row[field]);
      };
      const tastings = await store.tasting_session.bulkGet([...ids]);
      addReferences(tastings, ["bottle_id", "sku_id"]);
      for (const tasting of tastings)
        if (tasting?.user_id === session.userId && typeof tasting.bottle_id === "string")
          directIds.add(tasting.bottle_id);
      addReferences(await store.bottle.bulkGet([...ids]), ["purchase_id"]);
      addReferences(await store.purchase.bulkGet([...ids]), ["sku_id"]);
      addReferences(await store.sku.bulkGet([...ids]), ["product_id"]);
      return (await store.outbox.toArray()).some(
        (entry) =>
          ids.has(entry.entity_id) ||
          entry.touched_ids?.some((id) => ids.has(id)) ||
          Object.entries(entry.fields).some(
            ([key, value]) =>
              ["bottle_id", "purchase_id", "tasting_session_id"].includes(key) &&
              typeof value === "string" &&
              directIds.has(value),
          ),
      );
    },
  );
  session.assertCurrent();
  return blocked
    ? "관련 기록에 동기화 대기 또는 실패한 변경이 있습니다. 동기화 상태를 확인한 뒤 정정해 주세요. 입력은 유지됩니다."
    : null;
}

async function beforeSubmit(session: WriteSession, ids: string[]): Promise<void> {
  if (!navigator.onLine)
    throw new Error("정정은 온라인에서 저장할 수 있습니다. 입력은 유지됩니다.");
  const reason = await getCorrectionBlockReason(session, ids);
  if (reason) throw new Error(reason);
  session.assertCurrent();
}

export async function submitTastingCorrection(
  id: string,
  input: TastingCorrectionInput,
  session: WriteSession,
) {
  await beforeSubmit(session, [
    id,
    ...input.expected_bottles.map((bottle) => bottle.id),
    ...(input.changes.sku_id ? [input.changes.sku_id] : []),
    ...(input.changes.bottle_id ? [input.changes.bottle_id] : []),
  ]);
  const result = await tastingsApi.correct(id, input);
  session.assertCurrent();
  // 멱등 재요청은 과거 응답일 수 있다. 미러는 최신 pull로만 갱신한다.
  void syncEngine.triggerSync();
  return result;
}

export async function submitPurchaseSkuCorrection(
  id: string,
  input: PurchaseSkuCorrectionInput,
  session: WriteSession,
) {
  await beforeSubmit(session, [
    id,
    input.target_sku_id,
    ...input.expected_bottles.map((bottle) => bottle.id),
    ...input.expected_tastings.map((tasting) => tasting.id),
  ]);
  const result = await purchasesApi.correctSku(id, input);
  session.assertCurrent();
  void syncEngine.triggerSync();
  return result;
}
