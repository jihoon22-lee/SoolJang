import type { CategoryNode, ProductFilters, SortKey, SortOrder, Vendor } from "@/api/types";
import { formatCategoryPath } from "@/format";

interface ProductFilterPanelProps {
  filters: ProductFilters;
  categories: CategoryNode[];
  vendors: Vendor[];
  onChange: (next: ProductFilters) => void;
  onReset: () => void;
  /** 모바일 폭 기본 접힘(항목 2). 부모(`ProductsPage`)가 쥔다 — "/" 단축키가 접힌 상태에서도
   * 검색창으로 포커스를 옮길 수 있어야 하기 때문이다. */
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "이름" },
  { value: "created_at", label: "등록일" },
  { value: "updated_at", label: "수정일" },
  { value: "abv", label: "도수" },
  { value: "vintage", label: "빈티지" },
  { value: "personal_rating", label: "내 평점" },
  { value: "price_per_100ml", label: "100ml당 가격" },
  { value: "avg_list_price", label: "평단가" },
  { value: "avg_paid_price", label: "평균 실구매가" },
  { value: "paid_total", label: "총 실구매액" },
  { value: "in_stock_count", label: "재고 병수" },
  { value: "purchased_count", label: "총 구매 병수" },
];

/**
 * 제품 목록 필터.
 *
 * 모든 필터는 서버에서 AND 로 결합된다. 필터를 바꾸면 커서를 버리고 첫 페이지부터 다시
 * 읽어야 하는데, 그 처리는 목록 화면이 담당한다.
 *
 * 국가·빈티지 범위·구매처·품종·100ml당 가격 범위는 자주 쓰는 필터가 아니라
 * `<details>` 로 접어 둔다 — 항상 펼쳐 두면 자주 쓰는 필터(이름·주종·도수)를 찾기 더
 * 어려워진다.
 */
export function ProductFilterPanel({
  filters,
  categories,
  vendors,
  onChange,
  onReset,
  expanded,
  onExpandedChange,
}: ProductFilterPanelProps) {
  const update = (patch: Partial<ProductFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="panel filter-panel">
      <div className="section-header">
        <h2 id="filter-heading">검색과 필터</h2>
        <button
          type="button"
          className="filter-panel-toggle"
          aria-expanded={expanded}
          aria-controls="filter-panel-body"
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? "접기" : "펼치기"}
        </button>
      </div>
      <form
        id="filter-panel-body"
        className={
          expanded ? "filter-panel-body" : "filter-panel-body filter-panel-body--collapsed"
        }
        aria-labelledby="filter-heading"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="field">
          <label htmlFor="filter-q">이름 검색</label>
          <input
            id="filter-q"
            type="search"
            value={filters.q ?? ""}
            placeholder="한글·영문 부분 검색"
            onChange={(event) => update({ q: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="filter-category">주종</label>
          <select
            id="filter-category"
            value={filters.category_id ?? ""}
            onChange={(event) => update({ category_id: event.target.value || undefined })}
          >
            <option value="">전체</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {formatCategoryPath(category.path)}
                {category.descendant_product_count > 0 && ` (${category.descendant_product_count})`}
              </option>
            ))}
          </select>
          <p className="muted text-sm mt-0 mb-0">
            상위 주종을 고르면 하위 주종까지 포함해 찾습니다.
          </p>
        </div>

        <fieldset className="field fieldset-plain">
          <legend className="sr-only">도수 범위</legend>
          <label htmlFor="filter-abv-min">도수 (%)</label>
          <div className="field-row">
            <input
              id="filter-abv-min"
              type="number"
              min={0}
              max={100}
              step="0.1"
              placeholder="최소"
              value={filters.abv_min ?? ""}
              onChange={(event) => update({ abv_min: event.target.value || undefined })}
            />
            <input
              aria-label="도수 최대"
              type="number"
              min={0}
              max={100}
              step="0.1"
              placeholder="최대"
              value={filters.abv_max ?? ""}
              onChange={(event) => update({ abv_max: event.target.value || undefined })}
            />
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="filter-rating">내 평점 최소</label>
          <input
            id="filter-rating"
            type="number"
            min={0.5}
            max={6}
            step="0.5"
            placeholder="예: 4"
            value={filters.rating_min ?? ""}
            onChange={(event) => update({ rating_min: event.target.value || undefined })}
          />
        </div>

        <div className="field">
          <label htmlFor="filter-stock">재고</label>
          <select
            id="filter-stock"
            value={filters.in_stock === undefined ? "" : String(filters.in_stock)}
            onChange={(event) =>
              update({
                in_stock: event.target.value === "" ? undefined : event.target.value === "true",
              })
            }
          >
            <option value="">전체</option>
            <option value="true">재고 있음</option>
            <option value="false">재고 없음</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-sort">정렬</label>
          <div className="field-row">
            <select
              id="filter-sort"
              value={filters.sort ?? "name"}
              onChange={(event) => update({ sort: event.target.value as SortKey })}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              aria-label="정렬 방향"
              value={filters.order ?? "asc"}
              onChange={(event) => update({ order: event.target.value as SortOrder })}
            >
              <option value="asc">오름차순</option>
              <option value="desc">내림차순</option>
            </select>
          </div>
        </div>

        <details className="field">
          <summary>더 많은 필터</summary>

          <div className="field mt-2">
            <label htmlFor="filter-country">국가</label>
            <input
              id="filter-country"
              value={filters.country ?? ""}
              placeholder="예: 스코틀랜드"
              onChange={(event) => update({ country: event.target.value || undefined })}
            />
          </div>

          <fieldset className="field fieldset-plain">
            <legend className="sr-only">빈티지 범위</legend>
            <label htmlFor="filter-vintage-min">빈티지</label>
            <div className="field-row">
              <input
                id="filter-vintage-min"
                type="number"
                min={1800}
                max={2200}
                placeholder="최소"
                value={filters.vintage_min ?? ""}
                onChange={(event) =>
                  update({
                    vintage_min: event.target.value ? Number(event.target.value) : undefined,
                  })
                }
              />
              <input
                aria-label="빈티지 최대"
                type="number"
                min={1800}
                max={2200}
                placeholder="최대"
                value={filters.vintage_max ?? ""}
                onChange={(event) =>
                  update({
                    vintage_max: event.target.value ? Number(event.target.value) : undefined,
                  })
                }
              />
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="filter-vendor">구매처</label>
            <select
              id="filter-vendor"
              value={filters.vendor_id ?? ""}
              onChange={(event) => update({ vendor_id: event.target.value || undefined })}
            >
              <option value="">전체</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="filter-variety">품종·스타일</label>
            <input
              id="filter-variety"
              value={filters.variety ?? ""}
              placeholder="예: Cabernet Sauvignon"
              onChange={(event) => update({ variety: event.target.value || undefined })}
            />
          </div>

          <fieldset className="field fieldset-plain">
            <legend className="sr-only">100ml당 가격 범위</legend>
            <label htmlFor="filter-price-min">100ml당 가격 (원)</label>
            <div className="field-row">
              <input
                id="filter-price-min"
                type="number"
                min={0}
                placeholder="최소"
                value={filters.price_per_100ml_min ?? ""}
                onChange={(event) =>
                  update({ price_per_100ml_min: event.target.value || undefined })
                }
              />
              <input
                aria-label="100ml당 가격 최대"
                type="number"
                min={0}
                placeholder="최대"
                value={filters.price_per_100ml_max ?? ""}
                onChange={(event) =>
                  update({ price_per_100ml_max: event.target.value || undefined })
                }
              />
            </div>
          </fieldset>

          <fieldset className="field fieldset-plain">
            <legend className="sr-only">구매일 범위</legend>
            <label htmlFor="filter-purchased-min">구매일</label>
            <div className="field-row">
              <input
                id="filter-purchased-min"
                type="date"
                value={filters.purchased_on_min ?? ""}
                onChange={(event) => update({ purchased_on_min: event.target.value || undefined })}
              />
              <input
                aria-label="구매일 최대"
                type="date"
                value={filters.purchased_on_max ?? ""}
                onChange={(event) => update({ purchased_on_max: event.target.value || undefined })}
              />
            </div>
          </fieldset>
        </details>

        <button type="button" onClick={onReset}>
          필터 초기화
        </button>
      </form>
    </div>
  );
}
