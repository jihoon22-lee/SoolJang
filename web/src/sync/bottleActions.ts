/**
 * 병 상태 전이 — 한 병이든 여러 병이든 같은 규칙으로 outbox 에 적재한다.
 *
 * 각 병은 독립된 outbox 명령 하나다. 서버(`application/sync.py`)는 다른 기기와 부딪힌
 * 전이를 `conflict` 로 돌려주고 나머지를 계속 적용하므로, 여러 병을 한 번에 처리해도 한
 * 병의 충돌이 나머지를 막지 않는다. 낙관적 갱신과 되돌리기도 병마다 따로 한다.
 */

import { todayLocal } from "@/format";
import {
  bottlePrecondition,
  confirmedBottleOperation,
  localBottleOperationKey,
  markBottleOperation,
} from "@/sync/bottleRevision";
import { db, type SyncRow } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { captureWriteSession } from "@/sync/writeSession";

export type TransitionAction =
  | "open"
  | "finish"
  | "gift"
  | "sell"
  | "reopen"
  | "unopen"
  | "set_remaining";

export interface TransitionOptions {
  /** 개봉·소진·증여·판매 날짜. 비우면 기기 시간대의 오늘. */
  on?: string | undefined;
  /** 증여·판매 메모(받는 사람, 판매처 등). */
  note?: string | undefined;
  /** `set_remaining` 의 잔량(ml). 0 이면 소진이다. */
  remainingMl?: number | undefined;
}

/** 현재 상태에서 그 동작이 가능한지. 서버 `application/tastings.py` 의 전이 규칙과 같다. */
export function canTransition(status: string, action: TransitionAction): boolean {
  switch (action) {
    case "open":
      return status === "unopened";
    case "finish":
      return status === "unopened" || status === "open";
    case "gift":
    case "sell":
      return status === "unopened" || status === "open";
    case "reopen":
      return status === "finished" || status === "gifted" || status === "sold";
    case "unopen":
      return status === "open";
    case "set_remaining":
      return status === "open";
  }
}

export async function bottleVolumeMl(purchaseId: string): Promise<number | null> {
  const purchase = await db.purchase.get(purchaseId);
  if (!purchase) return null;
  const sku = await db.sku.get(purchase.sku_id as string);
  return (sku?.volume_ml as number | undefined) ?? null;
}

/** 서버 상태 전이의 부작용을 오프라인 낙관적 갱신용으로 옮긴 것. */
export async function transitionFields(
  current: SyncRow,
  action: TransitionAction,
  options: TransitionOptions = {},
): Promise<Record<string, unknown>> {
  const day = options.on ?? todayLocal();
  switch (action) {
    case "open":
      return {
        status: "open",
        opened_on: current.opened_on ?? day,
        remaining_ml: await bottleVolumeMl(current.purchase_id as string),
      };
    case "finish":
      return {
        status: "finished",
        opened_on: current.opened_on ?? day,
        finished_on: day,
        remaining_ml: 0,
      };
    case "gift":
      return { status: "gifted", finished_on: day };
    case "sell":
      return { status: "sold", finished_on: day };
    case "reopen":
      // 소진으로 0 이 된 잔량은 실제 잔량이 아니다 — 서버(`reopen_bottle`)처럼 미기록으로 돌린다.
      return {
        status: "open",
        finished_on: null,
        opened_on: current.opened_on ?? day,
        remaining_ml: current.remaining_ml === 0 ? null : current.remaining_ml,
      };
    case "unopen":
      return { status: "unopened", opened_on: null, remaining_ml: null };
    case "set_remaining": {
      const remaining = options.remainingMl ?? 0;
      if (remaining === 0) {
        return {
          status: "finished",
          opened_on: current.opened_on ?? day,
          finished_on: day,
          remaining_ml: 0,
        };
      }
      return { remaining_ml: remaining };
    }
  }
}

/**
 * 낙관적 필드 중 서버 `_dispatch_bottle_action` 이 읽는 것만 outbox `fields` 로 옮긴다.
 * 오프라인에서 한 행동의 실제 날짜를 보내야 재접속 시점 날짜로 바뀌지 않는다.
 */
export function transitionOutboxFields(
  action: TransitionAction,
  fields: Record<string, unknown>,
  options: TransitionOptions = {},
): Record<string, unknown> {
  switch (action) {
    case "open":
      return { opened_on: fields.opened_on, remaining_ml: fields.remaining_ml };
    case "finish":
      return { finished_on: fields.finished_on };
    case "gift":
    case "sell":
      return options.note
        ? { on: fields.finished_on, note: options.note }
        : { on: fields.finished_on };
    case "reopen":
    case "unopen":
      return {};
    case "set_remaining":
      return { remaining_ml: options.remainingMl ?? 0, on: options.on ?? todayLocal() };
  }
}

const STATE_FIELDS = ["status", "opened_on", "finished_on", "remaining_ml", "note"] as const;

function stateOf(row: SyncRow): Record<string, unknown> {
  return Object.fromEntries(STATE_FIELDS.map((key) => [key, row[key] ?? null]));
}

export interface AppliedBottleTransition {
  id: string;
  before: SyncRow;
  operationId: string;
  after: Record<string, unknown>;
}

async function applyTransition(
  bottleId: string,
  action: TransitionAction,
  options: TransitionOptions,
  skipInvalid = false,
): Promise<AppliedBottleTransition | null> {
  const session = captureWriteSession();
  const store = db;
  return store.transaction("rw", store.tables, async () => {
    session.assertCurrent();
    const current = await store.bottle.get(bottleId);
    if (!current || current.deleted_at !== null) {
      if (skipInvalid) return null;
      throw new Error("병을 찾을 수 없습니다");
    }
    if (!canTransition(current.status as string, action)) {
      if (skipInvalid) return null;
      throw new Error("지금 상태에서는 할 수 없는 동작입니다");
    }
    if (
      action === "unopen" &&
      (await store.tasting_session.where("bottle_id").equals(bottleId).count())
    )
      throw new Error("시음 기록이 있는 병은 개봉을 취소할 수 없습니다. 기록과 잔량을 확인하세요");
    const condition = ["reopen", "unopen", "set_remaining"].includes(action)
      ? await bottlePrecondition(store, current)
      : {};
    const fields = await transitionFields(current, action, options);
    const after = { ...current, ...fields, updated_at: new Date().toISOString() };
    session.assertCurrent();
    const operationId = await enqueue({
      entity: "bottle",
      op: "action",
      entityId: bottleId,
      action,
      fields: { ...transitionOutboxFields(action, fields, options), ...condition },
      optimisticRow: after,
    });
    await markBottleOperation(store, bottleId, operationId);
    session.assertCurrent();
    return { id: bottleId, before: current, operationId, after: stateOf(after) };
  });
}

/** 병 하나의 낙관적 반영·명령 적재·변경 식별자를 같은 transaction으로 저장한다. */
export async function applyBottleTransition(
  bottleId: string,
  action: TransitionAction,
  options: TransitionOptions = {},
): Promise<SyncRow> {
  const applied = await applyTransition(bottleId, action, options);
  if (!applied) throw new Error("병을 찾을 수 없습니다");
  return applied.before;
}

export interface BulkTransitionResult {
  applied: AppliedBottleTransition[];
  skipped: string[];
}

export async function applyBottleTransitions(
  bottleIds: readonly string[],
  action: TransitionAction,
  options: TransitionOptions = {},
): Promise<BulkTransitionResult> {
  const session = captureWriteSession();
  const result: BulkTransitionResult = { applied: [], skipped: [] };
  for (const id of bottleIds) {
    session.assertCurrent();
    const applied = await applyTransition(id, action, options, true);
    if (applied) result.applied.push(applied);
    else result.skipped.push(id);
  }
  return result;
}

export interface UndoBottleResult {
  applied: string[];
  skipped: string[];
}

/** 원동작 이후의 변경을 덮지 않는다. 서버도 원 receipt의 revision과 before를 다시 검증한다. */
export async function undoBottleTransitions(
  applied: BulkTransitionResult["applied"],
): Promise<UndoBottleResult> {
  const session = captureWriteSession();
  const store = db;
  const result: UndoBottleResult = { applied: [], skipped: [] };
  for (const original of applied) {
    session.assertCurrent();
    const accepted = await store.transaction("rw", store.tables, async () => {
      session.assertCurrent();
      const current = await store.bottle.get(original.id);
      const last = (await store.sync_meta.get(localBottleOperationKey(original.id)))?.value;
      const confirmation = await confirmedBottleOperation(store, original.id);
      if (
        !current ||
        current.deleted_at !== null ||
        last !== original.operationId ||
        current.purchase_id !== original.before.purchase_id ||
        (confirmation?.operationId !== original.operationId &&
          JSON.stringify(stateOf(current)) !== JSON.stringify(original.after)) ||
        (confirmation?.operationId === original.operationId &&
          (confirmation.status !== "applied" || confirmation.revision !== current.revision))
      )
        return false;
      const queue = await store.outbox.toArray();
      const origin = queue.find((entry) => entry.idempotency_key === original.operationId);
      if (origin?.status === "failed") return false;
      if (!origin && confirmation?.operationId !== original.operationId) return false;
      const condition = origin
        ? { expected_operation_id: original.operationId }
        : { expected_revision: confirmation?.revision };
      const operationId = await enqueue({
        entity: "bottle",
        op: "action",
        entityId: original.id,
        action: "undo",
        fields: { origin_operation_id: original.operationId, ...condition },
        optimisticRow: {
          ...current,
          ...stateOf(original.before),
          updated_at: new Date().toISOString(),
        },
      });
      await markBottleOperation(store, original.id, operationId);
      session.assertCurrent();
      return true;
    });
    (accepted ? result.applied : result.skipped).push(original.id);
  }
  return result;
}
