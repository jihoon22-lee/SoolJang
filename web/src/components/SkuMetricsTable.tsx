/**
 * 규격(용량)별 지표. 같은 술을 375ml·750ml 로 샀다면 제품 전체 평단가는 두 용량이 섞인 값이다.
 * 용량마다 병당 가격·100ml당 가격·재고를 따로 보여준다. 계산은 제품 지표와 같은 도메인
 * 규칙(`domain/metrics.ts`)을 구매 건에 그대로 적용한다(오프라인에서도 같다).
 */

import Decimal from "decimal.js";
import type { Bottle, Product, Purchase } from "@/api/types";
import { computePriceMetrics, purchaseLot } from "@/domain/metrics";
import { formatMoney, formatVolume } from "@/format";

function decimalOrNull(value: string | null): Decimal | null {
  return value === null ? null : new Decimal(value);
}

export function SkuMetricsTable({
  product,
  purchases,
  bottles,
}: {
  product: Product;
  purchases: Purchase[];
  bottles: Bottle[];
}) {
  if (product.skus.length < 2) return null;
  const skuOfPurchase = new Map(purchases.map((purchase) => [purchase.id, purchase.sku_id]));
  const rows = product.skus.map((sku) => {
    const skuPurchases = purchases.filter(
      (purchase) => purchase.sku_id === sku.id && purchase.quantity > 0,
    );
    const metrics = computePriceMetrics(
      skuPurchases.map((purchase) =>
        purchaseLot(
          purchase.quantity,
          sku.volume_ml,
          decimalOrNull(purchase.unit_list_price),
          decimalOrNull(purchase.unit_paid_price),
        ),
      ),
    );
    const inStock = bottles.filter(
      (bottle) =>
        skuOfPurchase.get(bottle.purchase_id) === sku.id &&
        (bottle.status === "unopened" || bottle.status === "open"),
    ).length;
    return { sku, metrics, inStock };
  });

  return (
    <section aria-labelledby="sku-metrics-heading" className="sku-metrics">
      <h3 id="sku-metrics-heading">용량별</h3>
      <div className="table-scroll table-scroll--always">
        <table className="product-table purchase-table">
          <caption className="sr-only">용량별 구매·재고·가격</caption>
          <thead>
            <tr>
              <th scope="col">용량</th>
              <th scope="col" className="numeric">
                구매
              </th>
              <th scope="col" className="numeric">
                재고
              </th>
              <th scope="col" className="numeric">
                실평단가
              </th>
              <th scope="col" className="numeric">
                100ml당(정가)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ sku, metrics, inStock }) => (
              <tr key={sku.id}>
                <th scope="row">{formatVolume(sku.volume_ml)}</th>
                <td className="numeric">{metrics.purchasedCount}병</td>
                <td className="numeric">{inStock}병</td>
                <td className="numeric">
                  {formatMoney(metrics.avgPaidPrice?.toFixed(2) ?? null, { short: true })}
                </td>
                <td className="numeric">
                  {formatMoney(metrics.pricePer100ml?.toFixed(2) ?? null, { short: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
