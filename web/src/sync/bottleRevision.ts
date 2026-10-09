/** 병별 로컬 명령과 서버 확인 revision. 계정별 sync_meta 안에서 함께 갱신한다. */
import type { OutboxEntry, SoolJangDB, SyncRow } from "@/sync/db";

export const localBottleOperationKey = (id: string): string => `bottle-local-operation:${id}`;
export const confirmedBottleOperationKey = (id: string): string =>
  `bottle-confirmed-operation:${id}`;

export interface ConfirmedBottleOperation {
  operationId: string;
  revision: string;
  status: "applied" | "conflict";
}

export async function markBottleOperation(
  store: SoolJangDB,
  bottleId: string,
  operationId: string,
): Promise<void> {
  await store.sync_meta.put({ key: localBottleOperationKey(bottleId), value: operationId });
}

export async function confirmedBottleOperation(
  store: SoolJangDB,
  bottleId: string,
): Promise<ConfirmedBottleOperation | null> {
  const value = (await store.sync_meta.get(confirmedBottleOperationKey(bottleId)))?.value;
  if (!value) return null;
  return JSON.parse(value) as ConfirmedBottleOperation;
}

function affectsBottle(entry: OutboxEntry, bottleId: string): boolean {
  return (
    (entry.entity === "bottle" && entry.entity_id === bottleId) ||
    (entry.entity === "tasting_session" && entry.fields.bottle_id === bottleId)
  );
}

/** 낙관적 시각을 서버 revision으로 취급하지 않는다. pending이면 앞선 명령 receipt를 참조한다. */
export async function bottlePrecondition(
  store: SoolJangDB,
  bottle: SyncRow,
): Promise<Record<string, string>> {
  const pending = (await store.outbox.toArray())
    .filter((entry) => affectsBottle(entry, bottle.id))
    .sort((a, b) =>
      (a.sequence_key ?? a.idempotency_key).localeCompare(b.sequence_key ?? b.idempotency_key),
    );
  const previous = pending.at(-1);
  if (previous) {
    if (previous.status === "failed")
      throw new Error("이 병의 동기화 실패를 먼저 확인하세요. 입력은 보존됩니다");
    return { expected_operation_id: previous.idempotency_key };
  }
  if (typeof bottle.revision !== "string")
    throw new Error("최신 병 상태가 필요합니다. 온라인에서 동기화한 뒤 다시 시도하세요");
  return { expected_revision: bottle.revision };
}
