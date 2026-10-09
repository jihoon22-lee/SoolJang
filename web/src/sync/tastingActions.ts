/**
 * 시음 기록 — 병 패널의 기록 폼과 "오늘 마셨어요" 빠른 기록이 같은 규칙을 쓴다.
 *
 * `application/tastings.py::record_tasting` 의 병 부작용(미개봉 자동 개봉, 앞선 날 시음이면
 * 개봉일 보정, 잔량 차감, 0 이 되면 자동 소진)을 오프라인 낙관적 갱신으로 옮긴 것이다.
 * 서버는 같은 명령 하나로 기록과 병 변화를 함께 처리하므로 병 변화는 별도 명령이 아니다.
 */

import { bottleVolumeMl } from "@/sync/bottleActions";
import { markBottleOperation } from "@/sync/bottleRevision";
import { databaseIdentity, db } from "@/sync/db";
import { validNumericInput } from "@/sync/inputContract";
import { enqueue } from "@/sync/outbox";
import { newId } from "@/sync/uuid7";

export interface TastingRecordInput {
  bottleId: string;
  tastedOn: string;
  pouredMl: number | null;
  /** "4.5" 같은 0.5 단위 문자열. 없으면 null. */
  rating: string | null;
  nose?: string | undefined;
  palate?: string | undefined;
  finish?: string | undefined;
  place?: string | undefined;
  companions?: string | undefined;
  userId: string;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** 시음을 기록한다. 만든 시음 기록 id 를 돌려준다. */
export async function recordTasting(input: TastingRecordInput): Promise<string> {
  const store = db;
  const generation = databaseIdentity().generation;
  const pouredText = input.pouredMl === null ? "" : String(input.pouredMl);
  if (
    !validNumericInput("poured_ml", pouredText) ||
    !validNumericInput("tasting_rating", input.rating ?? "")
  )
    throw new Error("시음량은 양의 정수, 평점은 0~6점의 0.5 단위로 입력하세요");

  return await store.transaction("rw", store.tables, async () => {
    const bottleRow = await store.bottle.get(input.bottleId);
    if (!bottleRow) throw new Error("병을 찾을 수 없습니다");
    if (bottleRow.status === "gifted" || bottleRow.status === "sold") {
      throw new Error(`내보낸 병은 시음을 기록할 수 없습니다 (현재 상태: ${bottleRow.status})`);
    }

    const updates: Record<string, unknown> = {};
    if (bottleRow.status === "unopened") {
      updates.status = "open";
      updates.opened_on = input.tastedOn;
      updates.remaining_ml = await bottleVolumeMl(bottleRow.purchase_id as string);
    }
    // 기록된 개봉일보다 앞선 날 마셨다면 그날 이미 열려 있었다.
    const openedOn = (updates.opened_on ?? bottleRow.opened_on) as string | null;
    if (openedOn === null || input.tastedOn < openedOn) updates.opened_on = input.tastedOn;

    if (input.pouredMl !== null) {
      let remaining = (updates.remaining_ml ?? bottleRow.remaining_ml) as number | null | undefined;
      if (remaining === null || remaining === undefined) {
        remaining = (await bottleVolumeMl(bottleRow.purchase_id as string)) ?? 0;
      }
      if (input.pouredMl > remaining) {
        throw new Error(
          `잔량이 부족합니다. 남은 양 ${remaining}ml, 따르려는 양 ${input.pouredMl}ml`,
        );
      }
      updates.remaining_ml = remaining - input.pouredMl;
      if (updates.remaining_ml === 0) {
        updates.status = "finished";
        updates.finished_on = input.tastedOn;
      }
    }

    const purchase = await store.purchase.get(bottleRow.purchase_id as string);
    const skuId = purchase?.sku_id as string | undefined;
    if (!skuId) throw new Error("무엇을 마셨는지 확인할 수 없습니다");

    const now = new Date().toISOString();
    const tastingId = newId();
    const text = {
      nose: clean(input.nose),
      palate: clean(input.palate),
      finish: clean(input.finish),
      place: clean(input.place),
      companions: clean(input.companions),
    };
    const operationId = await enqueue({
      entity: "tasting_session",
      op: "action",
      entityId: tastingId,
      action: "record_tasting",
      fields: {
        bottle_id: input.bottleId,
        sku_id: skuId,
        tasted_on: input.tastedOn,
        ...(input.pouredMl !== null ? { poured_ml: input.pouredMl } : {}),
        ...(input.rating ? { rating: input.rating } : {}),
        ...Object.fromEntries(Object.entries(text).filter(([, value]) => value !== null)),
      },
      // 병 상태·잔량도 이 명령의 부작용으로 바뀐다. 보호 id 로 남겨 동시에 도는 pull 이
      // 방금 바꾼 잔량을 이전 서버 값으로 덮지 않게 한다.
      touchedIds: [input.bottleId],
      optimisticRow: {
        id: tastingId,
        user_id: input.userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        bottle_id: input.bottleId,
        sku_id: skuId,
        tasted_on: input.tastedOn,
        poured_ml: input.pouredMl,
        rating: input.rating,
        note: null,
        ...text,
      },
    });
    await markBottleOperation(store, input.bottleId, operationId);
    if (Object.keys(updates).length > 0) {
      await store.bottle.update(input.bottleId, { ...updates, updated_at: now });
    }
    if (databaseIdentity().generation !== generation || db !== store)
      throw new Error("계정이 변경되어 입력을 저장하지 않았습니다");
    return tastingId;
  });
}

// --- 직전 장소·동석자 기억 ---------------------------------------------------------

const CONTEXT_PREFIX = "sooljang:last-tasting-context:";

export interface TastingContext {
  place: string;
  companions: string;
}

/**
 * 장소·동석자는 개인 기록이라 계정별로 둔다. 같은 기기에서 다른 계정으로 로그인하면 이전
 * 계정의 값이 미리 채워지면 안 된다. 로컬 저장소 소유자가 정해지지 않았으면 기억하지 않는다.
 */
function contextKey(): string | null {
  const userId = databaseIdentity().userId;
  return userId ? `${CONTEXT_PREFIX}${encodeURIComponent(userId)}` : null;
}

/** 같은 자리에서 여러 병을 기록할 때 장소·동석자를 다시 치지 않게 한다(계정·기기별). */
export function lastTastingContext(): TastingContext {
  const key = contextKey();
  if (!key) return { place: "", companions: "" };
  try {
    const raw = JSON.parse(
      window.localStorage.getItem(key) ?? "null",
    ) as Partial<TastingContext> | null;
    return { place: raw?.place ?? "", companions: raw?.companions ?? "" };
  } catch {
    return { place: "", companions: "" };
  }
}

export function rememberTastingContext(context: TastingContext): void {
  const key = contextKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(context));
  } catch {
    // 기억하지 못할 뿐 기록은 이미 저장됐다.
  }
}
