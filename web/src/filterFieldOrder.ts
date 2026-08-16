/**
 * 필터 패널 항목 순서 기억.
 *
 * 상시 표시/"더 많은 필터" 접힘 구분은 카테고리가 아니라 **이 순서 배열에서 몇
 * 번째냐** 로 정해진다(`ALWAYS_VISIBLE_FIELD_COUNT` 개까지 상시 표시) — 그래서 항목을
 * 경계 너머로 옮기면 상시/접힘이 자동으로 바뀐다. 기기별 표시 설정이라 서버에 동기화할
 * 이유가 없다(`lastVendor.ts`·`stockFirstPreference.ts` 와 같은 이유).
 */

export type FilterFieldId =
  | "q"
  | "category"
  | "abv"
  | "rating"
  | "stock"
  | "sort"
  | "stockFirst"
  | "country"
  | "vintage"
  | "vendor"
  | "variety"
  | "price100ml"
  | "purchasedOn";

export const DEFAULT_FILTER_FIELD_ORDER: FilterFieldId[] = [
  "q",
  "category",
  "abv",
  "rating",
  "stock",
  "sort",
  "stockFirst",
  "country",
  "vintage",
  "vendor",
  "variety",
  "price100ml",
  "purchasedOn",
];

/** 이 개수까지는 상시 표시하고, 그 이후는 "더 많은 필터" 아코디언에 접힌다. 사용자가
 * 조정할 수 없는 고정값이다 — 순서만 바꿔서 경계를 넘나든다. */
export const ALWAYS_VISIBLE_FIELD_COUNT = 7;

const STORAGE_KEY = "sooljang:products-filter-order";

export function getFilterFieldOrder(): FilterFieldId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTER_FIELD_ORDER;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_FILTER_FIELD_ORDER;

    const known = new Set<string>(DEFAULT_FILTER_FIELD_ORDER);
    // 저장값에 모르는 id(옛 필드가 없어졌거나 오염된 값)가 섞여 있으면 버린다.
    const kept = (parsed as unknown[]).filter(
      (id): id is FilterFieldId => typeof id === "string" && known.has(id),
    );
    // 저장 당시엔 없던 새 필드는 기본 순서 상의 위치를 유지한 채 끝에 붙인다 — 그러지
    // 않으면 스키마가 늘어날 때마다 새 필드가 조용히 화면에서 사라진다.
    const keptSet = new Set(kept);
    const missing = DEFAULT_FILTER_FIELD_ORDER.filter((id) => !keptSet.has(id));
    return [...kept, ...missing];
  } catch {
    return DEFAULT_FILTER_FIELD_ORDER;
  }
}

export function setFilterFieldOrder(order: FilterFieldId[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // 프라이빗 브라우징 등 — 기억 못 하는 것뿐 기능이 막히면 안 된다.
  }
}

/** 인접한 항목과 자리를 바꾼다. 이미 맨 앞이면 그대로 돌려준다. */
export function moveFieldUp<T>(order: T[], id: T): T[] {
  const index = order.indexOf(id);
  if (index <= 0) return order;
  return swap(order, index, index - 1);
}

/** 인접한 항목과 자리를 바꾼다. 이미 맨 끝이면 그대로 돌려준다. */
export function moveFieldDown<T>(order: T[], id: T): T[] {
  const index = order.indexOf(id);
  if (index === -1 || index >= order.length - 1) return order;
  return swap(order, index, index + 1);
}

function swap<T>(order: T[], i: number, j: number): T[] {
  const next = [...order];
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return order;
  next[i] = b;
  next[j] = a;
  return next;
}
