import type { Product } from "@/api/types";
import { formatAbv, formatCategoryPath, formatMoney, formatRating, formatVolume } from "@/format";

interface ProductListProps {
  products: Product[];
  onSelect: (productId: string) => void;
}

/**
 * 제품 목록.
 *
 * 같은 데이터를 테이블과 카드로 두 번 렌더하고 CSS 로 하나만 보이게 한다. JS 뷰포트 감지를
 * 쓰지 않는 이유는 초기 페인트에서 잘못된 뷰가 잠깐 보이는 문제를 피하고, 테스트에서 두 뷰를
 * 모두 검증할 수 있기 때문이다.
 */
export function ProductList({ products, onSelect }: ProductListProps) {
  if (products.length === 0) {
    return (
      <output className="notice">
        조건에 맞는 술이 없습니다. 필터를 조정하거나 새 술을 등록해 보세요.
      </output>
    );
  }

  return (
    <>
      <table className="product-table">
        <caption className="sr-only">제품 목록. 이름을 선택하면 상세 화면으로 이동합니다.</caption>
        <thead>
          <tr>
            <th scope="col">이름</th>
            <th scope="col">주종</th>
            <th scope="col" className="numeric">
              도수
            </th>
            <th scope="col" className="numeric">
              재고
            </th>
            <th scope="col" className="numeric">
              평단가
            </th>
            <th scope="col" className="numeric">
              100ml당
            </th>
            <th scope="col" className="numeric">
              내 평점
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={product.id}>
              <th scope="row">
                <button type="button" className="link-like" onClick={() => onSelect(product.id)}>
                  {product.name}
                </button>
                {product.vintage !== null && <span className="muted"> ({product.vintage})</span>}
              </th>
              <td>{formatCategoryPath(product.category_path)}</td>
              <td className="numeric">{formatAbv(product.abv)}</td>
              <td className="numeric">
                <StockBadge count={product.metrics.in_stock_count} />
              </td>
              <td className="numeric">
                {formatMoney(product.metrics.avg_list_price, { short: true })}
              </td>
              <td className="numeric">
                {formatMoney(product.metrics.price_per_100ml, { short: true })}
              </td>
              <td className="numeric">{formatRating(product.personal_rating)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="product-cards" aria-label="제품 목록 (카드 보기)">
        {products.map((product) => (
          <li key={product.id} className="product-card">
            <h3>
              <button type="button" className="link-like" onClick={() => onSelect(product.id)}>
                {product.name}
              </button>
            </h3>
            <p className="muted">
              {formatCategoryPath(product.category_path)}
              {product.vintage !== null && ` · ${product.vintage}`}
              {product.skus.length > 0 && ` · ${formatVolume(product.skus[0]?.volume_ml)}`}
            </p>
            <StockBadge count={product.metrics.in_stock_count} />
            <dl>
              <dt>도수</dt>
              <dd>{formatAbv(product.abv)}</dd>
              <dt>평단가</dt>
              <dd>{formatMoney(product.metrics.avg_list_price)}</dd>
              <dt>100ml당</dt>
              <dd>{formatMoney(product.metrics.price_per_100ml)}</dd>
              <dt>내 평점</dt>
              <dd>{formatRating(product.personal_rating)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function StockBadge({ count }: { count: number }) {
  const hasStock = count > 0;
  return (
    <span className={`badge ${hasStock ? "stock-some" : "stock-none"}`}>
      {hasStock ? `재고 ${count}병` : "재고 없음"}
    </span>
  );
}
