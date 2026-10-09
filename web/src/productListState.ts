import type { ProductFilters } from "@/api/types";

export interface ProductListState {
  filters: ProductFilters;
  visibleCount: number;
  scrollY: number;
  tableScrollTop?: number;
}
const key = (owner: string) => `sooljang:product-list:${owner}`;
export function readProductListState(owner: string): ProductListState | null {
  if (!owner) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key(owner)) ?? "null");
    if (
      !value ||
      typeof value.filters !== "object" ||
      value.filters === null ||
      !Number.isFinite(value.visibleCount) ||
      value.visibleCount < 1 ||
      !Number.isFinite(value.scrollY)
    )
      return null;
    return {
      filters: value.filters,
      visibleCount: Math.min(value.visibleCount, 100000),
      scrollY: Math.max(0, value.scrollY),
      ...(Number.isFinite(value.tableScrollTop)
        ? { tableScrollTop: Math.max(0, value.tableScrollTop) }
        : {}),
    };
  } catch {
    return null;
  }
}
export function saveProductListState(owner: string, state: ProductListState): void {
  if (!owner) return;
  try {
    sessionStorage.setItem(key(owner), JSON.stringify(state));
  } catch {
    /* Storage unavailable: keep React state. */
  }
}
