/** 서버·로컬 조회가 제공하는 같은 SKU 집계를 표시한다. UI에서 가격을 다시 계산하지 않는다. */
import type { Product } from "@/api/types";
import { productSkuSummaries, skuHistoryLabel } from "@/components/productDisplay";
import { formatMoney, formatVolume } from "@/format";

export function SkuSummaryList({
  product,
  onSelect,
}: {
  product: Product;
  onSelect: (skuId: string) => void;
}) {
  const rows = productSkuSummaries(product);
  if (rows === null) return <p className="muted sku-summary-unavailable">규격별 정보 준비 중</p>;
  if (rows.length === 0) return <p className="muted">등록된 규격 없음</p>;
  return (
    <ul className="sku-summary-list" aria-label="규격별 재고와 실평단가">
      {rows.map((row) => (
        <li key={row.sku_id}>
          <button type="button" className="sku-summary-button" onClick={() => onSelect(row.sku_id)}>
            <span className="sku-summary-title">
              {formatVolume(row.volume_ml)}
              {skuHistoryLabel(row.metrics) ? (
                <span className="muted"> · {skuHistoryLabel(row.metrics)}</span>
              ) : null}
            </span>
            <span>
              재고 {row.metrics.in_stock_count}병 · 개봉 {row.metrics.opened_count} · 미개봉{" "}
              {row.metrics.unopened_count}
            </span>
            <span>실평단가 {formatMoney(row.metrics.avg_paid_price)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SkuMetricsTable({
  product,
  selectedSkuId,
  onSelect,
  disabled = false,
}: {
  product: Product;
  selectedSkuId?: string | undefined;
  onSelect?: ((skuId: string | undefined) => void) | undefined;
  disabled?: boolean;
}) {
  if (product.skus.length < 2) return null;
  const rows = productSkuSummaries(product);
  return (
    <section aria-labelledby="sku-metrics-heading" className="sku-metrics">
      <div className="section-header">
        <h3 id="sku-metrics-heading">용량별</h3>
        {selectedSkuId && onSelect ? (
          <button type="button" disabled={disabled} onClick={() => onSelect(undefined)}>
            전체 규격 보기
          </button>
        ) : null}
      </div>
      {rows === null ? (
        <p className="muted">규격별 정보 준비 중</p>
      ) : (
        <div className="table-scroll table-scroll--always">
          <table className="product-table purchase-table sku-metrics-table">
            <caption className="sr-only">용량별 구매·재고·가격</caption>
            <thead>
              <tr>
                <th scope="col">용량</th>
                <th scope="col">상태</th>
                <th scope="col" className="numeric">
                  구매
                </th>
                <th scope="col" className="numeric">
                  재고
                </th>
                <th scope="col" className="numeric">
                  개봉 / 미개봉
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
              {rows.map((row) => (
                <tr
                  key={row.sku_id}
                  className={selectedSkuId === row.sku_id ? "sku-selected" : undefined}
                >
                  <th scope="row">
                    {onSelect ? (
                      <button
                        type="button"
                        className="link-like"
                        aria-pressed={selectedSkuId === row.sku_id}
                        disabled={disabled}
                        onClick={() => onSelect(row.sku_id)}
                      >
                        {formatVolume(row.volume_ml)}
                      </button>
                    ) : (
                      formatVolume(row.volume_ml)
                    )}
                  </th>
                  <td data-label="상태">{skuHistoryLabel(row.metrics) ?? "보유 중"}</td>
                  <td className="numeric" data-label="구매">
                    {row.metrics.purchased_count}병
                  </td>
                  <td className="numeric" data-label="재고">
                    {row.metrics.in_stock_count}병
                  </td>
                  <td className="numeric" data-label="개봉 / 미개봉">
                    {row.metrics.opened_count} / {row.metrics.unopened_count}
                  </td>
                  <td className="numeric" data-label="실평단가">
                    {formatMoney(row.metrics.avg_paid_price, { short: true })}
                  </td>
                  <td className="numeric" data-label="100ml당(정가)">
                    {formatMoney(row.metrics.price_per_100ml, { short: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
