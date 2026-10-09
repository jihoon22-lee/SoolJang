/**
 * 병 상태 전이 — 한 병이든 여러 병이든 같은 규칙으로 outbox 에 적재한다.
 *
 * 각 병은 독립된 outbox 명령 하나다. 서버(`application/sync.py`)는 다른 기기와 부딪힌
 * 전이를 `conflict` 로 돌려주고 나머지를 계속 적용하므로, 여러 병을 한 번에 처리해도 한
 * 병의 충돌이 나머지를 막지 않는다. 낙관적 갱신과 되돌리기도 병마다 따로 한다.
 */

import { todayLocal } from "@/format";
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

/** 병 하나에 상태 전이를 적용한다(낙관적 반영 + outbox). 전이 전 행을 돌려준다. */
export async function applyBottleTransition(
  bottleId: string,
  action: TransitionAction,
  options: TransitionOptions = {},
): Promise<SyncRow> {
  const session = captureWriteSession();
  session.assertCurrent();
  const current = await db.bottle.get(bottleId);
  if (!current) throw new Error("병을 찾을 수 없습니다");
  if (!canTransition(current.status as string, action))
    throw new Error("지금 상태에서는 할 수 없는 동작입니다");
  const fields = await transitionFields(current, action, options);
  session.assertCurrent();
  await enqueue({
    entity: "bottle",
    op: "action",
    entityId: bottleId,
    action,
    fields: transitionOutboxFields(action, fields, options),
    optimisticRow: { ...current, ...fields, updated_at: new Date().toISOString() },
  });
  return current;
}

export interface BulkTransitionResult {
  /** 적용한 병과 적용 전 상태. 실행 취소에 쓴다. */
  applied: { id: string; before: SyncRow }[];
  /** 지금 상태에서 할 수 없어 건너뛴 병(예: 이미 소진한 병의 개봉). */
  skipped: string[];
}

/** 여러 병에 같은 전이를 적용한다. 할 수 없는 병은 건너뛰고 나머지는 계속한다. */
export async function applyBottleTransitions(
  bottleIds: readonly string[],
  action: TransitionAction,
  options: TransitionOptions = {},
): Promise<BulkTransitionResult> {
  const session = captureWriteSession();
  const result: BulkTransitionResult = { applied: [], skipped: [] };
  for (const id of bottleIds) {
    session.assertCurrent();
    const current = await db.bottle.get(id);
    if (!current || !canTransition(current.status as string, action)) {
      result.skipped.push(id);
      continue;
    }
    session.assertCurrent();
    const before = await applyBottleTransition(id, action, options);
    result.applied.push({ id, before });
  }
  return result;
}

/**
 * 직전 일괄 전이를 되돌린다. 서버에는 "삭제"가 아니라 역방향 전이를 보낸다 — 기록을 지우지
 * 않고 상태만 원래대로 돌린다(`reopen`/`unopen` 조합).
 */
export async function undoBottleTransitions(
  applied: BulkTransitionResult["applied"],
): Promise<void> {
  const session = captureWriteSession();
  for (const { id, before } of applied) {
    session.assertCurrent();
    const current = await db.bottle.get(id);
    if (!current) continue;
    session.assertCurrent();
    const target = before.status as string;
    let status = current.status as string;
    if (status === target) {
      // 잔량 조정처럼 상태가 그대로인 경우는 잔량만 되돌린다.
      if (status === "open" && before.remaining_ml !== current.remaining_ml) {
        const remaining = before.remaining_ml as number | null;
        if (remaining !== null && remaining > 0) {
          await applyBottleTransition(id, "set_remaining", { remainingMl: remaining });
        }
      }
      continue;
    }
    if (status !== "open" && status !== "unopened") {
      await applyBottleTransition(id, "reopen");
      status = "open";
    }
    if (target === "unopened" && status === "open") {
      await applyBottleTransition(id, "unopen");
      continue;
    }
    // 소진 되돌리기는 잔량을 미기록으로 돌린다 — 전이 전에 알던 잔량이 있으면 복원한다.
    const remaining = before.remaining_ml as number | null;
    const now = await db.bottle.get(id);
    if (
      target === "open" &&
      remaining !== null &&
      remaining > 0 &&
      now?.remaining_ml !== remaining
    ) {
      await applyBottleTransition(id, "set_remaining", { remainingMl: remaining });
    }
  }
}
