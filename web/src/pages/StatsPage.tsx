/**
 * 통계 대시보드 화면.
 *
 * 엑셀 통계표(주종별 통계·랭킹 3종·합계)를 재현한다(`docs/plan.md` Task 14). 필터·수정이
 * 없는 읽기 전용 화면이라 `CategoriesPage` 처럼 단일 쿼리 조합 + 조기 반환 패턴을 쓴다.
 *
 * 오프라인에서도 봐야 하므로 Dexie 로컬 미러 기반 `sync/queries.ts` 로 계산한다(Task 15).
 *
 * 랭킹의 술 이름과 주종별 집계 행은 "내 술" 탭으로 건너뛰는 크로스 링크다(사용자 요청) —
 * `App.tsx` 가 `onSelectProduct`/`onSelectCategory` 를 `navigate` 에 연결해 준다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";

import type { CategoryStat, RankingEntry } from "@/api/types";
import { PivotExplorer } from "@/components/PivotExplorer";
import { formatAbv, formatMoney, formatPercent, formatRating, formatVolume } from "@/format";
import {
  getCategoryRollup,
  getCategoryTree,
  getStatsRankings,
  getStatsSummary,
} from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

type CategorySortKey =
  | "name"
  | "bottle_count"
  | "total_spend"
  | "avg_abv"
  | "avg_rating"
  | "avg_price_per_100ml"
  | "discount_rate";
type SortOrder = "asc" | "desc";

//: `getCategoryRollup()` 의 기본 정렬(병수 내림차순)과 맞춘다 — 처음 진입했을 때 순서가
//: 갑자기 바뀌어 보이면 안 된다.
const DEFAULT_CATEGORY_SORT: CategorySortKey = "bottle_count";
const DEFAULT_CATEGORY_ORDER: SortOrder = "desc";

const CATEGORY_SORT_ACCESSORS: Record<CategorySortKey, (stat: CategoryStat) => number | string> = {
  name: (stat) => stat.name,
  bottle_count: (stat) => stat.bottle_count,
  total_spend: (stat) => (stat.total_spend !== null ? Number(stat.total_spend) : -Infinity),
  avg_abv: (stat) => (stat.avg_abv !== null ? Number(stat.avg_abv) : -Infinity),
  avg_rating: (stat) => (stat.avg_rating !== null ? Number(stat.avg_rating) : -Infinity),
  avg_price_per_100ml: (stat) =>
    stat.avg_price_per_100ml !== null ? Number(stat.avg_price_per_100ml) : -Infinity,
  discount_rate: (stat) => (stat.discount_rate !== null ? Number(stat.discount_rate) : -Infinity),
};

function sortCategories(
  categories: CategoryStat[],
  sort: CategorySortKey,
  order: SortOrder,
): CategoryStat[] {
  const accessor = CATEGORY_SORT_ACCESSORS[sort];
  return [...categories].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : a.name.localeCompare(b.name);
    return order === "asc" ? cmp : -cmp;
  });
}

interface StatsPageProps {
  onSelectProduct: (productId: string) => void;
  onSelectCategory: (categoryId: string) => void;
}

export function StatsPage({ onSelectProduct, onSelectCategory }: StatsPageProps) {
  const { state } = useSyncStatus();
  const offline = state === "offline";
  const rankings = useLiveQuery(() => getStatsRankings(), []);
  const categoriesRaw = useLiveQuery(() => getCategoryRollup(), []);
  const totals = useLiveQuery(() => getStatsSummary(), []);
  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const [categorySort, setCategorySort] = useState<CategorySortKey>(DEFAULT_CATEGORY_SORT);
  const [categoryOrder, setCategoryOrder] = useState<SortOrder>(DEFAULT_CATEGORY_ORDER);

  if (rankings === undefined || categoriesRaw === undefined || totals === undefined) {
    return <output aria-live="polite">통계를 불러오고 있습니다…</output>;
  }

  function handleCategorySort(key: CategorySortKey) {
    if (categorySort === key) {
      setCategoryOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setCategorySort(key);
      setCategoryOrder("asc");
    }
  }

  const categories = sortCategories(categoriesRaw, categorySort, categoryOrder);
  const maxBottleCount = Math.max(1, ...categories.map((stat) => stat.bottle_count));

  return (
    <div className="stats-page">
      <h2>통계</h2>

      <section aria-labelledby="stats-summary-heading">
        <h3 id="stats-summary-heading">전체 합계</h3>
        <dl className="metrics-grid">
          <Metric label="구매 병수" value={`${totals.purchased_count.toLocaleString("ko-KR")}병`} />
          <Metric
            label="소비 / 재고"
            value={`${totals.consumed_count.toLocaleString("ko-KR")} / ${totals.in_stock_count.toLocaleString("ko-KR")}병`}
          />
          <Metric
            label="미개봉 / 개봉"
            value={`${totals.unopened_count.toLocaleString("ko-KR")} / ${totals.opened_count.toLocaleString("ko-KR")}병`}
          />
          <Metric label="총 용량" value={formatVolume(totals.total_volume_ml)} />
          <Metric label="정가 총액" value={formatMoney(totals.list_total)} />
          <Metric label="실구매 총액" value={formatMoney(totals.paid_total)} />
          <Metric label="병당 평균 정가" value={formatMoney(totals.avg_list_price)} />
          <Metric label="병당 평균 실구매가" value={formatMoney(totals.avg_paid_price)} />
          <Metric label="평균 100ml당 가격" value={formatMoney(totals.avg_price_per_100ml)} />
          <Metric label="평균 할인율" value={formatPercent(totals.discount_rate)} />
          <Metric label="평균 내 평점" value={formatRating(totals.avg_personal_rating)} />
          <Metric label="고유 구매처" value={`${totals.vendor_count.toLocaleString("ko-KR")}곳`} />
        </dl>
      </section>

      <section aria-labelledby="stats-category-heading">
        <h3 id="stats-category-heading">주종별 집계</h3>

        {categories.length === 0 ? (
          <p className="muted">등록된 술이 없습니다.</p>
        ) : (
          <>
            {/* 표와 같은 병수 데이터를 같은 정렬 순서로 보여준다. 주종을 누르면 그 주종
                필터가 걸린 "내 술" 탭으로 이동한다("미분류" 는 실제 카테고리가 아니라
                건너뛸 곳이 없어 비활성이다). */}
            <ul className="category-bars">
              {categories.map((stat) => (
                <li className="category-bar-row" key={stat.category_id ?? "uncategorized"}>
                  {stat.category_id ? (
                    <button
                      type="button"
                      className="sort-button category-bar-label"
                      onClick={() => onSelectCategory(stat.category_id as string)}
                    >
                      {stat.name}
                    </button>
                  ) : (
                    <span className="category-bar-label">{stat.name}</span>
                  )}
                  <span className="category-bar-track">
                    <span
                      className="category-bar-fill"
                      style={{ width: `${(stat.bottle_count / maxBottleCount) * 100}%` }}
                    />
                  </span>
                  <span className="numeric">{stat.bottle_count.toLocaleString("ko-KR")}병</span>
                </li>
              ))}
            </ul>

            <CategoryTable
              categories={categories}
              sort={categorySort}
              order={categoryOrder}
              onSort={handleCategorySort}
              onSelectCategory={onSelectCategory}
            />
          </>
        )}
      </section>

      <section aria-labelledby="stats-rankings-heading">
        <h3 id="stats-rankings-heading">랭킹</h3>
        <div className="ranking-grid">
          <RankingList
            title="병당 가격"
            hint="실구매 기준"
            entries={rankings.by_bottle_price}
            formatValue={formatMoney}
            onSelectProduct={onSelectProduct}
          />
          <RankingList
            title="총 구매액"
            hint="실구매 기준"
            entries={rankings.by_total_spend}
            formatValue={formatMoney}
            onSelectProduct={onSelectProduct}
          />
          <RankingList
            title="100ml당 가격"
            hint="정가 기준"
            entries={rankings.by_price_per_100ml}
            formatValue={formatMoney}
            onSelectProduct={onSelectProduct}
          />
          <RankingList
            title="개인 평점"
            entries={rankings.by_personal_rating}
            formatValue={formatRating}
            onSelectProduct={onSelectProduct}
          />
        </div>
      </section>

      {/* 커스텀 피벗·시계열·저장된 뷰는 서버 DB 조회를 전제해 온라인 전용이다(Task 20). */}
      {offline ? (
        <p className="muted">커스텀 피벗과 월별 시계열은 온라인일 때만 볼 수 있습니다.</p>
      ) : (
        <PivotExplorer categories={categoryTree?.items ?? []} />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface CategoryColumnDef {
  key: CategorySortKey;
  label: string;
  numeric?: boolean;
}

const CATEGORY_COLUMNS: CategoryColumnDef[] = [
  { key: "name", label: "주종" },
  { key: "bottle_count", label: "병수", numeric: true },
  { key: "total_spend", label: "총액", numeric: true },
  { key: "avg_abv", label: "평균 도수", numeric: true },
  { key: "avg_rating", label: "평균 평점", numeric: true },
  { key: "avg_price_per_100ml", label: "평균 100ml가", numeric: true },
  { key: "discount_rate", label: "할인율", numeric: true },
];

function CategoryTable({
  categories,
  sort,
  order,
  onSort,
  onSelectCategory,
}: {
  categories: CategoryStat[];
  sort: CategorySortKey;
  order: SortOrder;
  onSort: (key: CategorySortKey) => void;
  onSelectCategory: (categoryId: string) => void;
}) {
  return (
    <>
      <table className="stats-table">
        <thead>
          <tr>
            {CATEGORY_COLUMNS.map((column) => (
              <CategoryColumnHeader
                key={column.key}
                column={column}
                sort={sort}
                order={order}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((stat) => (
            <tr key={stat.category_id ?? "uncategorized"}>
              <th scope="row">
                {stat.category_id ? (
                  <button
                    type="button"
                    className="link-like"
                    onClick={() => onSelectCategory(stat.category_id as string)}
                  >
                    {stat.name}
                  </button>
                ) : (
                  stat.name
                )}
              </th>
              <td className="numeric">{stat.bottle_count.toLocaleString("ko-KR")}</td>
              <td className="numeric">{formatMoney(stat.total_spend)}</td>
              <td className="numeric">{formatAbv(stat.avg_abv)}</td>
              <td className="numeric">{formatRating(stat.avg_rating)}</td>
              <td className="numeric">{formatMoney(stat.avg_price_per_100ml)}</td>
              <td className="numeric">{formatPercent(stat.discount_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="stats-cards">
        {categories.map((stat) => (
          <li className="stats-card" key={stat.category_id ?? "uncategorized"}>
            <h4>
              {stat.category_id ? (
                <button
                  type="button"
                  className="link-like"
                  onClick={() => onSelectCategory(stat.category_id as string)}
                >
                  {stat.name}
                </button>
              ) : (
                stat.name
              )}
            </h4>
            <dl>
              <dt>병수</dt>
              <dd>{stat.bottle_count.toLocaleString("ko-KR")}병</dd>
              <dt>총액</dt>
              <dd>{formatMoney(stat.total_spend)}</dd>
              <dt>평균 도수</dt>
              <dd>{formatAbv(stat.avg_abv)}</dd>
              <dt>평균 평점</dt>
              <dd>{formatRating(stat.avg_rating)}</dd>
              <dt>평균 100ml가</dt>
              <dd>{formatMoney(stat.avg_price_per_100ml)}</dd>
              <dt>할인율</dt>
              <dd>{formatPercent(stat.discount_rate)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function CategoryColumnHeader({
  column,
  sort,
  order,
  onSort,
}: {
  column: CategoryColumnDef;
  sort: CategorySortKey;
  order: SortOrder;
  onSort: (key: CategorySortKey) => void;
}) {
  const active = sort === column.key;
  return (
    <th
      scope="col"
      className={column.numeric ? "numeric" : undefined}
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="sort-button" onClick={() => onSort(column.key)}>
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

function RankingList({
  title,
  hint,
  entries,
  formatValue,
  onSelectProduct,
}: {
  title: string;
  hint?: string;
  entries: RankingEntry[];
  formatValue: (value: string) => string;
  onSelectProduct: (productId: string) => void;
}) {
  return (
    <section aria-label={title}>
      <h4>
        {title}
        {hint ? <span className="muted"> ({hint})</span> : null}
      </h4>
      {entries.length === 0 ? (
        <p className="muted">데이터가 없습니다.</p>
      ) : (
        <ol className="ranking-list">
          {entries.map((entry, index) => (
            <li key={entry.product_id}>
              <span className="ranking-rank">{index + 1}</span>
              <button
                type="button"
                className="sort-button ranking-name"
                onClick={() => onSelectProduct(entry.product_id)}
              >
                {entry.product_name}
              </button>
              <span className="ranking-value">{formatValue(entry.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
