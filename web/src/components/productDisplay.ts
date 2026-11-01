import type { Product, ProductMetrics, SkuSummary } from "@/api/types";
import { formatAbv } from "@/format";

/** 요약이 없는 여러 규격의 가격을 제품 평균이나 첫 규격으로 추정하지 않는다. */
export function productSkuSummaries(product: Product): SkuSummary[] | null {
  if (product.skus.length === 0) return [];
  const rows = product.skus.map((sku) =>
    product.sku_summaries?.find((row) => row.sku_id === sku.id),
  );
  if (rows.some((row) => row === undefined)) {
    const only = product.skus.length === 1 ? product.skus[0] : undefined;
    return only ? [{ sku_id: only.id, volume_ml: only.volume_ml, metrics: product.metrics }] : null;
  }
  return (rows as SkuSummary[]).sort(
    (a, b) =>
      Number(b.metrics.in_stock_count > 0) - Number(a.metrics.in_stock_count > 0) ||
      a.volume_ml - b.volume_ml ||
      a.sku_id.localeCompare(b.sku_id),
  );
}

export function skuHistoryLabel(metrics: ProductMetrics): string | null {
  if (metrics.purchased_count === 0) return "구매 기록 없음";
  return metrics.in_stock_count === 0 ? "지난 규격" : null;
}

export function productEdition(product: {
  vintage: number | null;
  age_years: string | null;
  abv: string | null;
}): string {
  return [
    product.vintage != null ? `${product.vintage} 빈티지` : null,
    product.age_years != null ? `${Number(product.age_years)}년 숙성` : null,
    product.abv != null ? formatAbv(product.abv) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 사람이 읽는 구매 맥락. 같은 제품의 구매끼리만 비교하며 `productId`가 없으면 한 제품으로 본다. */
export interface PurchaseIdentity {
  id: string;
  productId?: string | null | undefined;
  volumeMl?: number | null | undefined;
  purchasedOn?: string | null | undefined;
  vendorName?: string | null | undefined;
}

function contextKey(purchase: PurchaseIdentity): string {
  return JSON.stringify([
    purchase.productId ?? null,
    purchase.volumeMl ?? null,
    purchase.purchasedOn ?? null,
    purchase.vendorName ?? null,
  ]);
}

/**
 * 용량·구매일·구매처가 같은 다른 구매가 있을 때만 줄인 내부 참조를 돌려준다(D264).
 * 맥락만으로 구분되면 `null` 이다. 저장·선택·라우팅에는 항상 원 UUID를 쓴다.
 */
export function purchaseReference(
  purchase: PurchaseIdentity,
  purchases: readonly PurchaseIdentity[],
): string | null {
  const key = contextKey(purchase);
  const others = purchases
    .filter((other) => other.id !== purchase.id && contextKey(other) === key)
    .map((other) => other.id);
  if (others.length === 0) return null;
  const { id } = purchase;
  let length = Math.min(8, id.length);
  while (length < id.length && others.some((other) => other.endsWith(id.slice(-length))))
    length += 1;
  return `구매 ${id.slice(-length)}`;
}
