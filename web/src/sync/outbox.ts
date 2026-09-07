/**
 * outbox 적재 — 오프라인 쓰기의 진입점.
 *
 * `docs/architecture.md` §5.2: 낙관적으로 로컬에 반영한 뒤 큐에 적재한다. 서버 왕복을
 * 기다리지 않는다. `enqueue` 호출자가 `id`(=idempotency_key 로도 쓰임)를 미리
 * 생성해(`sync/uuid7.ts`) 넘긴다 — 그래야 자식 레코드가 부모를 오프라인에서 바로
 * 참조할 수 있다(구매 건 → 병 연쇄 생성).
 */

import {
  databaseIdentity,
  db,
  type OutboxEntry,
  SYNC_ENTITIES,
  type SyncEntity,
  type SyncRow,
} from "@/sync/db";
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
  const store = db;
  const identity = databaseIdentity();
  const idempotencyKey = newId();
  const now = new Date().toISOString();

  const entry: OutboxEntry = {
    idempotency_key: idempotencyKey,
    sequence_key: idempotencyKey,
    user_id: input.optimisticRow?.user_id ?? identity.userId ?? undefined,
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

  await store.transaction("rw", store.outbox, store.table(input.entity), async () => {
    if (identity.generation !== databaseIdentity().generation || store !== db)
      throw new Error("계정이 변경되어 입력을 저장하지 않았습니다");
    const existing = (await store.table(input.entity).get(input.entityId)) as SyncRow | undefined;
    entry.user_id ??= existing?.user_id;
    if (identity.userId && entry.user_id !== identity.userId)
      throw new Error("다른 계정의 입력을 저장할 수 없습니다");
    await store.outbox.add(entry);
    if (input.op === "delete") {
      const existing = await store.table(input.entity).get(input.entityId);
      if (existing) {
        await store
          .table(input.entity)
          .update(input.entityId, { deleted_at: now, updated_at: now });
      }
    } else if (input.optimisticRow) {
      await store.table(input.entity).put(input.optimisticRow);
    }
    if (identity.generation !== databaseIdentity().generation || store !== db)
      throw new Error("계정이 변경되어 입력을 저장하지 않았습니다");
  });

  syncEvents.dispatchEvent(new Event(OUTBOX_CHANGED));
  return idempotencyKey;
}

/** 실패한 부모에 의존하는 명령을 찾는다. 참조 ID와 병 연쇄 생성까지 추적한다. */
export function dependentEntries(entry: OutboxEntry, queue: OutboxEntry[]): OutboxEntry[] {
  const affected = new Set([entry.entity_id, ...(entry.touched_ids ?? [])]);
  for (const id of Array.isArray(entry.fields.bottle_ids) ? entry.fields.bottle_ids : []) {
    if (typeof id === "string") affected.add(id);
  }
  const result: OutboxEntry[] = [];
  const references = (value: unknown): boolean =>
    typeof value === "string"
      ? affected.has(value)
      : Array.isArray(value)
        ? value.some(references)
        : value !== null && typeof value === "object"
          ? Object.values(value).some(references)
          : false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of queue) {
      if (candidate.idempotency_key === entry.idempotency_key || result.includes(candidate))
        continue;
      if (
        affected.has(candidate.entity_id) ||
        references(candidate.fields) ||
        (candidate.touched_ids ?? []).some((id) => affected.has(id))
      ) {
        result.push(candidate);
        affected.add(candidate.entity_id);
        for (const id of candidate.touched_ids ?? []) affected.add(id);
        for (const id of Array.isArray(candidate.fields.bottle_ids)
          ? candidate.fields.bottle_ids
          : [])
          if (typeof id === "string") affected.add(id);
        changed = true;
      }
    }
  }
  return result;
}

/** 명시적으로 실패한 명령만 폐기한다. 의존 명령이 있으면 함께 폐기할 때만 허용한다. */
export async function discardFailedEntry(
  idempotencyKey: string,
  includeDependents = false,
): Promise<void> {
  const store = db;
  await store.transaction("rw", store.tables, async () => {
    const entry = await store.outbox.get(idempotencyKey);
    if (!entry) return;
    if (entry.status !== "failed")
      throw new Error("처리 결과가 확인되지 않은 명령은 폐기할 수 없습니다");
    const dependents = dependentEntries(entry, await store.outbox.toArray());
    if (dependents.length && !includeDependents)
      throw new Error(`연결된 대기 명령 ${dependents.length}건을 먼저 확인하세요`);
    const reconcile = new Set<string>(
      JSON.parse((await store.sync_meta.get("reconcile_ids"))?.value ?? "[]"),
    );
    for (const item of [entry, ...dependents]) {
      await store.outbox.delete(item.idempotency_key);
      reconcile.add(item.entity_id);
      for (const id of item.touched_ids ?? []) reconcile.add(id);
      if (item.op === "create" || item.entity === "tasting_session") {
        await store.table(item.entity).delete(item.entity_id);
        if (item.entity === "purchase") {
          const bottles = await store.bottle.where("purchase_id").equals(item.entity_id).toArray();
          await store.bottle.bulkDelete(bottles.map((row) => row.id));
        }
      }
    }
    await store.sync_meta.put({ key: "reconcile_ids", value: JSON.stringify([...reconcile]) });
    await store.sync_meta.delete("cursor");
  });
  syncEvents.dispatchEvent(new Event(OUTBOX_CHANGED));
}

/** 실패 receipt는 다시 실행되지 않는다. 수정은 같은 FIFO 위치의 새 멱등 명령이다. */
export async function replaceFailedEntry(
  idempotencyKey: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const store = db;
  const newKey = newId();
  await store.transaction(
    "rw",
    [store.outbox, ...SYNC_ENTITIES.map((entity) => store.table(entity))],
    async () => {
      const entry = await store.outbox.get(idempotencyKey);
      if (!entry || entry.status !== "failed")
        throw new Error("수정할 실패 명령을 찾을 수 없습니다");
      await store.outbox.delete(idempotencyKey);
      await store.outbox.add({
        ...entry,
        idempotency_key: newKey,
        sequence_key: entry.sequence_key ?? entry.idempotency_key,
        fields,
        status: "pending",
        error: null,
      });
      if (entry.op === "create" || entry.op === "update")
        await store.table(entry.entity).update(entry.entity_id, fields);
    },
  );
  syncEvents.dispatchEvent(new Event(OUTBOX_CHANGED));
  return newKey;
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
