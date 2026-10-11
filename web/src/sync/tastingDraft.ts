import type { TastingFieldValues } from "@/components/TastingFields";
import { todayLocal } from "@/format";
import { readFormDraftValue, useDraftState } from "@/sync/drafts";
import { lastTastingContext } from "@/sync/tastingActions";

/** 빠른 입력과 병 상세가 같은 계정·탭·병의 한 초안을 이어 쓴다. */
export const tastingDraftKey = (bottleId: string) => `quick-tasting:bottle:${bottleId}`;
export function emptyTastingValues(): TastingFieldValues {
  return {
    tastedOn: todayLocal(),
    pouredMl: "",
    rating: "",
    note: "",
    nose: "",
    palate: "",
    finish: "",
    ...lastTastingContext(),
  };
}
export function useTastingDraft(bottleId: string, carried?: TastingFieldValues | null) {
  return useDraftState<TastingFieldValues>(tastingDraftKey(bottleId), () => {
    const empty = carried ?? emptyTastingValues();
    return Object.fromEntries(
      Object.entries(empty).map(([key, value]) => [
        key,
        readFormDraftValue(`tasting:${bottleId}:${key}`, value),
      ]),
    ) as unknown as TastingFieldValues;
  });
}
