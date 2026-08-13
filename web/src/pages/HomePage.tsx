import { useLiveQuery } from "dexie-react-hooks";

import type { RankingEntry } from "@/api/types";
import { formatDate, formatMoney, formatRating, formatVolume } from "@/format";
import { getRecentProducts, getRecentTastings, getStatsDashboard } from "@/sync/queries";

interface HomePageProps {
  onSelectProduct: (productId: string) => void;
  onSelectCategory: (categoryId: string) => void;
}

/**
 * 홈 대시보드. 앱 진입 시 가장 먼저 보이는 화면이다.
 *
 * 오프라인에서도 봐야 하므로 전부 Dexie 로컬 미러 기반(`sync/queries.ts`)으로 계산한다 —
 * 요약 지표·주종별 보유·랭킹은 `getStatsDashboard`, 최근 활동은 별도 쿼리다. "내 술"/통계
 * 탭으로 건너뛰는 크로스 링크를 제공한다(랭킹·주종·최근 항목을 누르면 해당 화면으로 이동).
 */
export function HomePage({ onSelectProduct, onSelectCategory }: HomePageProps) {
  const dashboard = useLiveQuery(() => getStatsDashboard(), []);
  const recentProducts = useLiveQuery(() => getRecentProducts(5), []);
  const recentTastings = useLiveQuery(() => getRecentTastings(5), []);

  if (!dashboard || !recentProducts || !recentTastings) {
    return <output aria-live="polite">불러오는 중…</output>;
  }

  const { totals, categories, rankings } = dashboard;
  const topCategories = [...categories].sort((a, b) => b.bottle_count - a.bottle_count).slice(0, 6);

  return (
    <div className="home-page">
      <h2>홈</h2>

      <section aria-labelledby="home-summary-heading">
        <h3 id="home-summary-heading">요약</h3>
        <dl className="metrics-grid">
          <Metric label="구매 병수" value={`${totals.purchased_count.toLocaleString("ko-KR")}병`} />
          <Metric label="재고" value={`${totals.in_stock_count.toLocaleString("ko-KR")}병`} />
          <Metric
            label="미개봉 / 개봉"
            value={`${totals.unopened_count.toLocaleString("ko-KR")} / ${totals.opened_count.toLocaleString("ko-KR")}병`}
          />
          <Metric label="총 용량" value={formatVolume(totals.total_volume_ml)} />
          <Metric label="실구매 총액" value={formatMoney(totals.paid_total)} />
          <Metric label="고유 구매처" value={`${totals.vendor_count.toLocaleString("ko-KR")}곳`} />
        </dl>
      </section>

      <section aria-labelledby="home-categories-heading">
        <h3 id="home-categories-heading">주종별 보유</h3>
        {topCategories.length === 0 ? (
          <p className="muted">등록된 술이 없습니다.</p>
        ) : (
          <ul className="home-category-list">
            {topCategories.map((stat) => (
              <li key={stat.category_id ?? "uncategorized"}>
                {stat.category_id ? (
                  <button
                    type="button"
                    className="link-like"
                    onClick={() => onSelectCategory(stat.category_id as string)}
                  >
                    {stat.name}
                  </button>
                ) : (
                  <span>{stat.name}</span>
                )}
                <span className="muted">{stat.bottle_count.toLocaleString("ko-KR")}병</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-rankings-heading">
        <h3 id="home-rankings-heading">랭킹</h3>
        <div className="ranking-grid">
          <MiniRanking
            title="100ml당 가격"
            hint="정가 기준"
            entries={rankings.by_price_per_100ml.slice(0, 5)}
            formatValue={formatMoney}
            onSelectProduct={onSelectProduct}
          />
          <MiniRanking
            title="내 평점"
            entries={rankings.by_personal_rating.slice(0, 5)}
            formatValue={formatRating}
            onSelectProduct={onSelectProduct}
          />
        </div>
      </section>

      <section aria-labelledby="home-activity-heading">
        <h3 id="home-activity-heading">최근 활동</h3>
        <div className="home-activity-grid">
          <div>
            <h4>최근 등록</h4>
            {recentProducts.length === 0 ? (
              <p className="muted">아직 등록한 술이 없습니다.</p>
            ) : (
              <ul className="activity-list">
                {recentProducts.map((product) => (
                  <li key={product.id}>
                    <button
                      type="button"
                      className="link-like"
                      onClick={() => onSelectProduct(product.id)}
                    >
                      {product.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4>최근 시음</h4>
            {recentTastings.length === 0 ? (
              <p className="muted">아직 시음 기록이 없습니다.</p>
            ) : (
              <ul className="activity-list">
                {recentTastings.map((tasting) => (
                  <li key={tasting.id}>
                    {tasting.productId ? (
                      <button
                        type="button"
                        className="link-like"
                        onClick={() => onSelectProduct(tasting.productId as string)}
                      >
                        {tasting.productName}
                      </button>
                    ) : (
                      <span>{tasting.productName}</span>
                    )}
                    <span className="muted">
                      {formatDate(tasting.tastedOn)}
                      {tasting.rating ? ` · ${formatRating(tasting.rating)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
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

function MiniRanking({
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
