/**
 * outbox 적재 — 오프라인 쓰기의 진입점.
 *
 * `docs/architecture.md` §5.2: 낙관적으로 로컬에 반영한 뒤 큐에 적재한다. 서버 왕복을
 * 기다리지 않는다. `enqueue` 호출자가 `id`(=idempotency_key 로도 쓰임)를 미리
 * 생성해(`sync/uuid7.ts`) 넘긴다 — 그래야 자식 레코드가 부모를 오프라인에서 바로
 * 참조할 수 있다(구매 건 → 병 연쇄 생성).
 */

import { db, type OutboxEntry, type SyncEntity, type SyncRow } from "@/sync/db";
import { OUTBOX_CHANGED, syncEvents } from "@/sync/events";
import { newId } from "@/sync/uuid7";

export interface EnqueueInput {
  entity: SyncEntity;
  op: OutboxEntry["op"];
  entityId: string;
  action?: string | undefined;
  baseUpdatedAt?: string | undefined;
  fields: Record<string, unknown>;
  /** 낙관적으로 반영할 로컬 미러 행. `create`/`update` 에서만 준다. */
  optimisticRow?: SyncRow | undefined;
  /** `entityId` 외에 이 작업이 로컬에서 부작용으로 직접 건드리는 다른 엔티티 id들. */
  touchedIds?: string[] | undefined;
}

/** outbox 항목 하나를 적재하고, 있으면 로컬 미러도 낙관적으로 갱신한다. */
export async function enqueue(input: EnqueueInput): Promise<string> {
  const idempotencyKey = newId();
  const now = new Date().toISOString();

  const entry: OutboxEntry = {
    idempotency_key: idempotencyKey,
    entity: input.entity,
    op: input.op,
    entity_id: input.entityId,
    base_updated_at: input.baseUpdatedAt,
    action: input.action,
    fields: input.fields,
    created_at: now,
    status: "pending",
    error: null,
    touched_ids: input.touchedIds,
  };

  await db.transaction("rw", db.outbox, db.table(input.entity), async () => {
    await db.outbox.add(entry);
    if (input.op === "delete") {
      const existing = await db.table(input.entity).get(input.entityId);
      if (existing) {
        await db.table(input.entity).update(input.entityId, { deleted_at: now, updated_at: now });
      }
    } else if (input.optimisticRow) {
      await db.table(input.entity).put(input.optimisticRow);
    }
  });

  syncEvents.dispatchEvent(new Event(OUTBOX_CHANGED));
  return idempotencyKey;
}

/**
 * 실패로 확정된 outbox 항목을 사용자가 직접 건너뛴다(삭제).
 *
 * 서버가 이미 이 작업을 영구 실패로 기록했다(§5.2, `OutboxReceipt.status === "failed"`).
 * 그대로 두면 head-of-line blocking(같은 문서 §5.2) 때문에 이 항목 뒤의 모든 오프라인
 * 쓰기가 막힌 채로 남는다 — 사용자가 잘못된 값을 고쳐서 다시 등록하거나, 그냥 포기하고
 * 넘어갈 수 있게 이 함수를 제공한다.
 *
 * `create`(그리고 `tasting_session` 의 `action` — 실제로는 새 시음 기록을 만드는
 * 연산이라 `entity_id` 가 항상 신규 id 다)는 서버에 실제로 만들어진 적이 없는 로컬
 * 낙관적 행을 남긴다 — 이 행도 함께 지운다. 그 외(기존 엔티티를 수정하는 `update`,
 * 병 상태 전이 `action`)는 서버의 실제 값이 다음 풀에서 그대로 돌아오므로 outbox 항목만
 * 지우면 된다. 이 항목이 다른 아직 못 보낸 항목(예: 실패한 제품 생성 뒤에 줄 선
 * 규격·구매 생성)이 참조하던 대상이었다면, 그 뒤 항목들은 다음 시도에서 각자 새로
 * 실패해 이 패널에 차례로 나타난다 — 체인 전체를 한 번에 취소하지는 않는다.
 */
export async function discardFailedEntry(idempotencyKey: string): Promise<void> {
  const entry = await db.outbox.get(idempotencyKey);
  if (!entry) return;

  const isSyntheticCreate = entry.op === "create" || entry.entity === "tasting_session";

  await db.transaction("rw", db.outbox, db.table(entry.entity), async () => {
    await db.outbox.delete(idempotencyKey);
    if (isSyntheticCreate) {
      await db.table(entry.entity).delete(entry.entity_id);
    }
  });

  syncEvents.dispatchEvent(new Event(OUTBOX_CHANGED));
}

/**
 * 아직 서버에 반영되지 않은 outbox 항목이 가리키는 엔티티 id 집합.
 *
 * `entity_id` 뿐 아니라 `touched_ids`(부작용으로 같이 바뀐 다른 엔티티, 예: 시음 기록이
 * 건드리는 병)도 포함한다 — 그러지 않으면 `pullDeltas` 가 그 엔티티를 "대기 중인 로컬
 * 변경 없음"으로 오판해 스테일한 서버 값으로 덮어쓴다.
 */
export async function pendingEntityIds(): Promise<Set<string>> {
  const entries = await db.outbox.toArray();
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.entity_id);
    for (const touchedId of entry.touched_ids ?? []) ids.add(touchedId);
  }
  return ids;
}
