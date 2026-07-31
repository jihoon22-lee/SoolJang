import type { Product, Purchase } from "@/api/types";
import {
  formatAbv,
  formatCategoryPath,
  formatDate,
  formatMoney,
  formatPercent,
  formatRating,
  formatVolume,
} from "@/format";

interface ProductDetailProps {
  product: Product;
  purchases: Purchase[];
  onBack: () => void;
  onDelete: () => void;
  deleting: boolean;
}

/**
 * 제품 상세.
 *
 * 파생 지표를 먼저 보여준다. 사용자가 이 화면에서 가장 자주 확인하는 것이 "이 술이 얼마짜리
 * 였는지" 와 "몇 병 남았는지" 다. 구매 이력은 그 근거이므로 아래에 둔다.
 */
export function ProductDetail({
  product,
  purchases,
  onBack,
  onDelete,
  deleting,
}: ProductDetailProps) {
  const { metrics } = product;

  return (
    <article aria-labelledby="detail-heading">
      <div className="button-row" style={{ marginBottom: 12 }}>
        <button type="button" onClick={onBack}>
          ← 목록으로
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? "삭제 중…" : "삭제"}
        </button>
      </div>

      <div className="panel">
        <h2 id="detail-heading" style={{ marginBottom: 4 }}>
          {product.name}
          {product.vintage !== null && <span className="muted"> ({product.vintage})</span>}
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {formatCategoryPath(product.category_path)}
          {product.producer_name && ` · ${product.producer_name}`}
          {product.country && ` · ${product.country}`}
        </p>

        <dl className="product-card-dl" style={{ display: "grid", gap: 4 }}>
          <div>
            <dt className="muted">도수</dt>
            <dd style={{ margin: 0 }}>{formatAbv(product.abv)}</dd>
          </div>
          <div>
            <dt className="muted">규격</dt>
            <dd style={{ margin: 0 }}>
              {product.skus.length === 0
                ? "등록된 규격 없음"
                : product.skus.map((sku) => formatVolume(sku.volume_ml)).join(", ")}
            </dd>
          </div>
          <div>
            <dt className="muted">품종·스타일</dt>
            <dd style={{ margin: 0 }}>
              {product.varieties.length === 0 ? "—" : product.varieties.join(", ")}
            </dd>
          </div>
          <div>
            <dt className="muted">내 평점</dt>
            <dd style={{ margin: 0 }}>{formatRating(product.personal_rating)}</dd>
          </div>
        </dl>

        {product.note && <p style={{ whiteSpace: "pre-wrap" }}>{product.note}</p>}
      </div>

      <h3>파생 지표</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        모두 구매 기록에서 자동 계산됩니다. 직접 입력하거나 수정할 필요가 없습니다.
      </p>
      <dl className="metrics-grid">
        <Metric label="구매 병수" value={`${metrics.purchased_count}병`} />
        <Metric label="재고 병수" value={`${metrics.in_stock_count}병`} />
        <Metric
          label="미개봉 / 개봉"
          value={`${metrics.unopened_count} / ${metrics.opened_count}병`}
        />
        <Metric label="소진 병수" value={`${metrics.consumed_count}병`} />
        <Metric label="평단가" value={formatMoney(metrics.avg_list_price)} />
        <Metric label="실평단가" value={formatMoney(metrics.avg_paid_price)} />
        <Metric
          label="100ml당 가격"
          value={formatMoney(metrics.price_per_100ml)}
          hint="정가 기준"
        />
        <Metric label="할인율" value={formatPercent(metrics.discount_rate)} />
        <Metric label="총 지출" value={formatMoney(metrics.paid_total)} />
        <Metric
          label="재고 자산가치"
          value={formatMoney(metrics.inventory_value_at_cost)}
          hint="실평단가 기준"
        />
      </dl>

      <h3>구매 이력</h3>
      {purchases.length === 0 ? (
        <output className="notice">
          구매 기록이 없습니다. 같은 술을 여러 번 샀다면 구매 건을 각각 추가해 구매처와 가격을 따로
          남길 수 있습니다.
        </output>
      ) : (
        <table className="product-table" style={{ display: "table" }}>
          <caption className="sr-only">구매 이력</caption>
          <thead>
            <tr>
              <th scope="col">구매일</th>
              <th scope="col">구매처</th>
              <th scope="col" className="numeric">
                병수
              </th>
              <th scope="col" className="numeric">
                병당 정가
              </th>
              <th scope="col" className="numeric">
                병당 실구매가
              </th>
              <th scope="col" className="numeric">
                총 지출
              </th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((purchase) => (
              <tr key={purchase.id}>
                <td>{formatDate(purchase.purchased_on)}</td>
                <td>{purchase.vendor_name ?? "미기록"}</td>
                <td className="numeric">{purchase.quantity}</td>
                <td className="numeric">
                  {formatMoney(purchase.unit_list_price, { short: true })}
                </td>
                <td className="numeric">
                  {formatMoney(purchase.unit_paid_price, { short: true })}
                </td>
                <td className="numeric">{formatMoney(purchase.paid_total, { short: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <dt>
        {label}
        {hint && <span className="muted"> ({hint})</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
