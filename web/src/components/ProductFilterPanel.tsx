import type { CategoryNode, ProductFilters, SortKey, SortOrder } from "@/api/types";
import { formatCategoryPath } from "@/format";

interface ProductFilterPanelProps {
  filters: ProductFilters;
  categories: CategoryNode[];
  onChange: (next: ProductFilters) => void;
  onReset: () => void;
}

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "이름" },
  { value: "created_at", label: "등록일" },
  { value: "abv", label: "도수" },
  { value: "vintage", label: "빈티지" },
  { value: "personal_rating", label: "내 평점" },
  { value: "price_per_100ml", label: "100ml당 가격" },
  { value: "avg_list_price", label: "평단가" },
  { value: "in_stock_count", label: "재고 병수" },
];

/**
 * 제품 목록 필터.
 *
 * 모든 필터는 서버에서 AND 로 결합된다. 필터를 바꾸면 커서를 버리고 첫 페이지부터 다시
 * 읽어야 하는데, 그 처리는 목록 화면이 담당한다.
 */
export function ProductFilterPanel({
  filters,
  categories,
  onChange,
  onReset,
}: ProductFilterPanelProps) {
  const update = (patch: Partial<ProductFilters>) => onChange({ ...filters, ...patch });

  return (
    <form
      className="panel"
      aria-labelledby="filter-heading"
      onSubmit={(event) => event.preventDefault()}
    >
      <h2 id="filter-heading">검색과 필터</h2>

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
        <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
          상위 주종을 고르면 하위 주종까지 포함해 찾습니다.
        </p>
      </div>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
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

      <button type="button" onClick={onReset}>
        필터 초기화
      </button>
    </form>
  );
}
