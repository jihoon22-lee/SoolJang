import type Decimal from "decimal.js";
import type { FilteredPrices, Product, PurchaseScope } from "@/api/types";
import { computePriceMetrics, type PurchaseLot } from "@/domain/metrics";

export interface ScopedPurchase {
  id: string;
  skuId: string;
  volumeMl: number;
  vendorId: string | null;
  purchasedOn: string | null;
  inStockCount: number;
  lot: PurchaseLot;
}

export const hasPurchaseScope = (scope: PurchaseScope): boolean =>
  scope.volume_ml !== undefined ||
  scope.vendor_id !== undefined ||
  scope.purchased_on_min !== undefined ||
  scope.purchased_on_max !== undefined ||
  scope.in_stock !== undefined;

/** 구매 조건은 한 구매 건에 AND로 적용한다. 재고 평균은 같은 SKU의 과거 구매도 포함한다. */
export function selectPurchaseScope(
  product: Product,
  purchases: readonly ScopedPurchase[],
  scope: PurchaseScope,
) {
  const candidates = purchases.filter(
    (purchase) =>
      (scope.volume_ml === undefined || purchase.volumeMl === scope.volume_ml) &&
      (scope.vendor_id === undefined || purchase.vendorId === scope.vendor_id) &&
      (scope.purchased_on_min === undefined ||
        (purchase.purchasedOn !== null && purchase.purchasedOn >= scope.purchased_on_min)) &&
      (scope.purchased_on_max === undefined ||
        (purchase.purchasedOn !== null && purchase.purchasedOn <= scope.purchased_on_max)),
  );
  const stockCount = candidates.reduce((sum, purchase) => sum + purchase.inStockCount, 0);
  const requiresPurchase =
    scope.vendor_id !== undefined ||
    scope.purchased_on_min !== undefined ||
    scope.purchased_on_max !== undefined;
  const hasVolume =
    scope.volume_ml === undefined || product.skus.some((sku) => sku.volume_ml === scope.volume_ml);
  const included =
    hasVolume &&
    (!requiresPurchase || candidates.length > 0) &&
    (scope.in_stock === undefined || (scope.in_stock ? stockCount > 0 : stockCount === 0));
  const stockSkus = new Set(
    candidates.filter((purchase) => purchase.inStockCount > 0).map((purchase) => purchase.skuId),
  );
  const matching =
    scope.in_stock === true
      ? candidates.filter((purchase) => stockSkus.has(purchase.skuId))
      : candidates;
  return {
    included,
    stockCount,
    purchases: matching,
    purchaseIds: matching.map((purchase) => purchase.id),
  };
}

export type PriceSortKey = "avg_list_price" | "avg_paid_price" | "price_per_100ml" | "paid_total";
export function purchaseScopePrices(purchases: readonly ScopedPurchase[]): {
  prices: FilteredPrices;
  raw: Record<PriceSortKey, Decimal | null>;
} {
  const metrics = computePriceMetrics(purchases.map((purchase) => purchase.lot));
  return {
    prices: {
      purchased_count: metrics.purchasedCount,
      total_volume_ml: metrics.totalVolumeMl,
      list_total: metrics.listTotal?.toFixed(2) ?? null,
      paid_total: metrics.paidTotal?.toFixed(2) ?? null,
      avg_list_price: metrics.avgListPrice?.toFixed(2) ?? null,
      avg_paid_price: metrics.avgPaidPrice?.toFixed(2) ?? null,
      price_per_100ml: metrics.pricePer100ml?.toFixed(2) ?? null,
      price_per_100ml_paid: metrics.pricePer100mlPaid?.toFixed(2) ?? null,
      discount_rate: metrics.discountRate?.toFixed(4) ?? null,
    },
    raw: {
      avg_list_price:
        metrics.purchasedCount > 0
          ? (metrics.listTotal?.dividedBy(metrics.purchasedCount) ?? null)
          : null,
      avg_paid_price:
        metrics.purchasedCount > 0
          ? (metrics.paidTotal?.dividedBy(metrics.purchasedCount) ?? null)
          : null,
      price_per_100ml:
        metrics.totalVolumeMl > 0
          ? (metrics.listTotal?.times(100).dividedBy(metrics.totalVolumeMl) ?? null)
          : null,
      paid_total: metrics.paidTotal,
    },
  };
}

export function purchaseScopeLabel(scope: PurchaseScope): string | undefined {
  if (!hasPurchaseScope(scope)) return undefined;
  return scope.in_stock === true
    ? "재고 있는 규격의 조건에 맞는 구매 평균"
    : "조건에 맞는 구매 평균";
}
