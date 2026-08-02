/**
 * 통계 대시보드 화면.
 *
 * 엑셀 통계표(주종별 통계·랭킹 3종·합계)를 재현한다(`docs/plan.md` Task 14). 필터·수정이
 * 없는 읽기 전용 화면이라 `CategoriesPage` 처럼 단일 쿼리 조합 + 조기 반환 패턴을 쓴다.
 *
 * 오프라인에서도 봐야 하므로 Dexie 로컬 미러 기반 `sync/queries.ts` 로 계산한다(Task 15).
 */

import { useLiveQuery } from "dexie-react-hooks";

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

export function StatsPage() {
  const { state } = useSyncStatus();
  const offline = state === "offline";
  const rankings = useLiveQuery(() => getStatsRankings(), []);
  const categories = useLiveQuery(() => getCategoryRollup(), []);
  const totals = useLiveQuery(() => getStatsSummary(), []);
  const categoryTree = useLiveQuery(() => getCategoryTree(), []);

  if (rankings === undefined || categories === undefined || totals === undefined) {
    return <output aria-live="polite">통계를 불러오고 있습니다…</output>;
  }

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
            {/* 표가 같은 병수 데이터를 접근성 있게 담고 있으므로 막대 그래프는 장식으로 감춘다. */}
            <div className="category-bars" aria-hidden="true">
              {categories.map((stat) => (
                <div className="category-bar-row" key={stat.category_id ?? "uncategorized"}>
                  <span className="category-bar-label">{stat.name}</span>
                  <span className="category-bar-track">
                    <span
                      className="category-bar-fill"
                      style={{ width: `${(stat.bottle_count / maxBottleCount) * 100}%` }}
                    />
                  </span>
                  <span className="numeric">{stat.bottle_count.toLocaleString("ko-KR")}병</span>
                </div>
              ))}
            </div>

            <CategoryTable categories={categories} />
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
          />
          <RankingList
            title="총 구매액"
            hint="실구매 기준"
            entries={rankings.by_total_spend}
            formatValue={formatMoney}
          />
          <RankingList
            title="100ml당 가격"
            hint="정가 기준"
            entries={rankings.by_price_per_100ml}
            formatValue={formatMoney}
          />
          <RankingList
            title="개인 평점"
            entries={rankings.by_personal_rating}
            formatValue={formatRating}
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

function CategoryTable({ categories }: { categories: CategoryStat[] }) {
  return (
    <>
      <table className="stats-table">
        <thead>
          <tr>
            <th scope="col">주종</th>
            <th scope="col" className="numeric">
              병수
            </th>
            <th scope="col" className="numeric">
              총액
            </th>
            <th scope="col" className="numeric">
              평균 도수
            </th>
            <th scope="col" className="numeric">
              평균 평점
            </th>
            <th scope="col" className="numeric">
              평균 100ml가
            </th>
            <th scope="col" className="numeric">
              할인율
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((stat) => (
            <tr key={stat.category_id ?? "uncategorized"}>
              <th scope="row">{stat.name}</th>
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
            <h4>{stat.name}</h4>
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

function RankingList({
  title,
  hint,
  entries,
  formatValue,
}: {
  title: string;
  hint?: string;
  entries: RankingEntry[];
  formatValue: (value: string) => string;
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
              <span className="ranking-name">{entry.product_name}</span>
              <span className="ranking-value">{formatValue(entry.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
