import type { Product, ProductMetrics, SortKey, SortOrder } from "@/api/types";
import { productEdition } from "@/components/productDisplay";

import { SkuSummaryList } from "@/components/SkuMetricsTable";
import { formatAbv, formatCategoryPath, formatMoney, formatRating } from "@/format";
import type { ProductContext } from "@/router";

interface ProductListProps {
  products: Product[];
  priceScopeLabel?: string | undefined;
  onSelect: (productId: string, context?: ProductContext) => void;
  sort: SortKey;
  order: SortOrder;
  onSort: (key: SortKey) => void;
  /** 선택 모드(대량 편집)일 때 체크박스를 보여준다. */
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  /** 보이는 항목 전체 선택/해제(표 머리글 체크박스). */
  onToggleAll?: ((ids: string[], checked: boolean) => void) | undefined;
  onToggleSelect?: (productId: string) => void;
}

interface ColumnDef {
  /** `undefined` 면 정렬할 수 없는 열이다("주종" — 계층형이라 서버 `SortKey` 가 없다). */
  sortKey: SortKey | undefined;
  label: string;
  numeric?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { sortKey: "name", label: "이름" },
  { sortKey: "vintage", label: "빈티지", numeric: true },
  { sortKey: undefined, label: "주종" },
  { sortKey: "abv", label: "도수", numeric: true },
  { sortKey: "in_stock_count", label: "재고", numeric: true },
  { sortKey: "avg_list_price", label: "평단가", numeric: true },
  { sortKey: "price_per_100ml", label: "100ml당", numeric: true },
  { sortKey: "personal_rating", label: "내 평점", numeric: true },
];

/**
 * 제품 목록.
 *
 * 같은 데이터를 테이블과 카드로 두 번 렌더하고 CSS 로 하나만 보이게 한다. JS 뷰포트 감지를
 * 쓰지 않는 이유는 초기 페인트에서 잘못된 뷰가 잠깐 보이는 문제를 피하고, 테스트에서 두 뷰를
 * 모두 검증할 수 있기 때문이다.
 *
 * 헤더 클릭 정렬은 새 정렬 로직을 만들지 않는다 — `ProductFilterPanel` 의 정렬 드롭다운과
 * 똑같은 `sort`/`order` 상태를 그대로 토글할 뿐이다(부모 `ProductsPage` 가 상태를 쥔다).
 */
export function ProductList({
  products,
  priceScopeLabel,
  onSelect,
  sort,
  order,
  onSort,
  selectable = false,
  selectedIds,
  onToggleSelect,
  onToggleAll,
}: ProductListProps) {
  if (products.length === 0) {
    return (
      <output className="empty-state">
        <span className="empty-state-title">조건에 맞는 술이 없습니다</span>
        <span className="muted">필터를 조정하거나 새 술을 등록해 보세요.</span>
      </output>
    );
  }

  const filtered = products.some((product) => product.filtered_prices != null);
  const columns = COLUMNS.flatMap((column) => {
    if (column.sortKey === "avg_list_price" && filtered)
      return [
        { ...column, label: "조건 평균 정가" },
        { sortKey: "avg_paid_price" as const, label: "조건 평균 실구매가", numeric: true },
      ];
    if (column.sortKey === "price_per_100ml" && filtered)
      return [{ ...column, label: "조건 100ml당(정가)" }];
    return [column];
  });
  return (
    <>
      <div className="table-scroll">
        <table className="product-table">
          <caption className="sr-only">
            제품 목록. 이름을 선택하면 상세 화면으로 이동합니다.
          </caption>
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="select-col">
                  <input
                    type="checkbox"
                    aria-label="보이는 술 모두 선택"
                    checked={products.every((product) => selectedIds?.has(product.id) ?? false)}
                    onChange={(event) =>
                      onToggleAll?.(
                        products.map((product) => product.id),
                        event.currentTarget.checked,
                      )
                    }
                  />
                </th>
              )}
              {columns.map((column) => (
                <ColumnHeader
                  key={column.label}
                  column={column}
                  sort={sort}
                  order={order}
                  onSort={onSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                {selectable && (
                  <td className="select-col">
                    <input
                      type="checkbox"
                      aria-label={`${product.name} 선택`}
                      checked={selectedIds?.has(product.id) ?? false}
                      onChange={() => onToggleSelect?.(product.id)}
                    />
                  </td>
                )}
                <th scope="row">
                  <button type="button" className="link-like" onClick={() => onSelect(product.id)}>
                    {product.name}
                  </button>
                  {product.age_years !== null ? (
                    <span className="purchase-context">{Number(product.age_years)}년 숙성</span>
                  ) : null}
                  {product.skus.length > 1 || product.filtered_prices != null || priceScopeLabel ? (
                    <span className="purchase-context">
                      {priceScopeLabel ??
                        (product.filtered_prices != null
                          ? "조건에 맞는 구매 평균"
                          : "제품 가격: 전체 용량 구매 평균")}
                    </span>
                  ) : null}
                  <SkuSummaryList
                    product={product}
                    onSelect={(skuId) => onSelect(product.id, { skuId })}
                  />
                </th>
                <td className="numeric">{product.vintage ?? "—"}</td>
                <td>{formatCategoryPath(product.category_path)}</td>
                <td className="numeric">{formatAbv(product.abv)}</td>
                <td className="numeric">
                  <StockBadge
                    metrics={product.metrics}
                    allSkus={product.skus.length > 1 || product.filtered_stock_count != null}
                  />
                  {product.filtered_stock_count != null ? (
                    <span className="stock-breakdown">
                      조건 내 재고 {product.filtered_stock_count}병
                    </span>
                  ) : null}
                </td>
                <td className="numeric">
                  {formatMoney((product.filtered_prices ?? product.metrics).avg_list_price, {
                    short: true,
                  })}
                </td>
                {filtered ? (
                  <td className="numeric">
                    {formatMoney((product.filtered_prices ?? product.metrics).avg_paid_price, {
                      short: true,
                    })}
                  </td>
                ) : null}
                <td className="numeric">
                  {formatMoney((product.filtered_prices ?? product.metrics).price_per_100ml, {
                    short: true,
                  })}
                </td>
                <td className="numeric">{formatRating(product.personal_rating)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="product-cards" aria-label="제품 목록 (카드 보기)">
        {products.map((product) => (
          <li key={product.id} className="product-card">
            {selectable && (
              <label className="select-card">
                <input
                  type="checkbox"
                  aria-label={`${product.name} 선택`}
                  checked={selectedIds?.has(product.id) ?? false}
                  onChange={() => onToggleSelect?.(product.id)}
                />
              </label>
            )}
            <h3>
              <button type="button" className="link-like" onClick={() => onSelect(product.id)}>
                {product.name}
              </button>
            </h3>
            <p className="muted">
              {formatCategoryPath(product.category_path)}
              {productEdition(product) && ` · ${productEdition(product)}`}
            </p>
            {/* 모바일 카드는 두 줄 요약 — 재고와 가격·평점을 한 줄에 모아 한 화면에 더 많이 본다. */}
            <div className="product-card-meta">
              <StockBadge
                metrics={product.metrics}
                allSkus={product.skus.length > 1 || product.filtered_stock_count != null}
              />
              {product.filtered_stock_count != null ? (
                <span className="stock-breakdown">
                  조건 내 재고 {product.filtered_stock_count}병
                </span>
              ) : null}
            </div>
            <SkuSummaryList
              product={product}
              onSelect={(skuId) => onSelect(product.id, { skuId })}
            />
            {product.skus.length > 1 || product.filtered_prices != null || priceScopeLabel ? (
              <p className="muted text-sm">
                {priceScopeLabel ??
                  (product.filtered_prices != null
                    ? "조건에 맞는 구매 평균"
                    : "제품 가격은 전체 용량 구매 기준")}
              </p>
            ) : null}
            <dl className={product.filtered_prices != null ? "filtered-price-summary" : undefined}>
              <dt>{product.filtered_prices != null ? "조건 평균 정가" : "평단가"}</dt>
              <dd>{formatMoney((product.filtered_prices ?? product.metrics).avg_list_price)}</dd>
              {product.filtered_prices != null ? (
                <>
                  <dt>조건 평균 실구매가</dt>
                  <dd>{formatMoney(product.filtered_prices.avg_paid_price)}</dd>
                </>
              ) : null}
              <dt>{product.filtered_prices != null ? "조건 100ml당(정가)" : "100ml당"}</dt>
              <dd>{formatMoney((product.filtered_prices ?? product.metrics).price_per_100ml)}</dd>
              <dt>내 평점</dt>
              <dd>{formatRating(product.personal_rating)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function ColumnHeader({
  column,
  sort,
  order,
  onSort,
}: {
  column: ColumnDef;
  sort: SortKey;
  order: SortOrder;
  onSort: (key: SortKey) => void;
}) {
  if (column.sortKey === undefined) {
    return (
      <th scope="col" className={column.numeric ? "numeric" : undefined}>
        {column.label}
      </th>
    );
  }

  const active = sort === column.sortKey;
  return (
    <th
      scope="col"
      className={column.numeric ? "numeric" : undefined}
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="sort-button"
        onClick={() => onSort(column.sortKey as SortKey)}
      >
        {column.label}
        {active ? (
          <span aria-hidden="true" className="sort-indicator">
            {order === "asc" ? " ▲" : " ▼"}
          </span>
        ) : null}
      </button>
    </th>
  );
}

function StockBadge({ metrics, allSkus = false }: { metrics: ProductMetrics; allSkus?: boolean }) {
  const { in_stock_count: count, opened_count, unopened_count } = metrics;
  const hasStock = count > 0;
  return (
    <>
      <span className={`badge ${hasStock ? "stock-some" : "stock-none"}`}>
        {allSkus ? "전체 " : ""}
        {hasStock ? `재고 ${count}병` : "재고 없음"}
      </span>
      {hasStock && (
        <span className="stock-breakdown">
          개봉 {opened_count} / 미개봉 {unopened_count}
        </span>
      )}
    </>
  );
}
