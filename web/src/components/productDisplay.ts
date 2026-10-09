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

/** 표시용 참조만 줄인다. 저장·선택·라우팅에는 항상 원 UUID를 쓴다. */
export function purchaseReference(id: string, purchaseIds: readonly string[]): string {
  let length = Math.min(8, id.length);
  while (
    length < id.length &&
    purchaseIds.some((other) => other !== id && other.endsWith(id.slice(-length)))
  )
    length += 1;
  return `구매 ${id.slice(-length)}`;
}
