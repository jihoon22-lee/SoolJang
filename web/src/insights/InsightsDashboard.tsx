import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, useState } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { formatMoney, todayLocal } from "@/format";
import {
  calculateInsights,
  type Evidence,
  type InsightFilters,
  type RatingDimension,
} from "@/insights/calculate";
import { loadInsightSnapshot } from "@/insights/load";
import type { ProductContext } from "@/router";
import "@/insights/insights.css";
import { useViewState } from "@/viewState";

type SelectProduct = (productId: string, context?: ProductContext) => void;
function EvidenceList({
  items,
  label = "근거 기록",
  onSelectProduct,
  preview = false,
}: {
  items: Evidence[];
  label?: string;
  onSelectProduct: SelectProduct;
  preview?: boolean;
}) {
  const [open, setOpen] = useState(preview),
    [limit, setLimit] = useState(10);
  const list = (
    <>
      <ul className="insight-evidence">
        {items.slice(0, limit).map((item, index) => (
          <li key={`${item.id}:${index}`}>
            {item.productId ? (
              <button
                type="button"
                onClick={() => {
                  if (item.productId)
                    onSelectProduct(item.productId, {
                      ...(item.skuId ? { skuId: item.skuId } : {}),
                      ...(item.purchaseId ? { purchaseId: item.purchaseId } : {}),
                      ...(item.bottleId ? { bottleId: item.bottleId } : {}),
                      ...(item.tastingId ? { tastingId: item.tastingId } : {}),
                    });
                }}
              >
                {item.label}
              </button>
            ) : (
              <span>{item.label}</span>
            )}
            {item.detail ? <span className="muted">{item.detail}</span> : null}
          </li>
        ))}
      </ul>
      {items.length > limit ? (
        <button type="button" onClick={() => setLimit((value) => value + 20)}>
          근거 더 보기 ({limit}/{items.length})
        </button>
      ) : null}
    </>
  );
  if (preview) return items.length ? list : <p className="muted">해당 기록이 없습니다.</p>;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {label} · {items.length}건
      </summary>
      {open ? list : null}
    </details>
  );
}
function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}
const dimensions: { value: RatingDimension; label: string }[] = [
  { value: "category", label: "주종" },
  { value: "producer", label: "생산자" },
  { value: "region", label: "지역" },
  { value: "price", label: "가격대·구매 조건" },
];
function initialFilters(today: string): InsightFilters {
  return {
    from: new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10),
    to: today,
    categoryId: "",
    status: "all",
  };
}

export function InsightsDashboard({
  onSelectProduct,
  onOpenQuality,
  today = todayLocal(),
}: {
  onSelectProduct: SelectProduct;
  onOpenQuality?: (() => void) | undefined;
  today?: string;
}) {
  const source = useLiveQuery(async () => {
    try {
      return { data: await loadInsightSnapshot(), error: null };
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error.message : "기록을 불러오지 못했습니다.",
      };
    }
  }, []);
  // 근거 → 제품 → 뒤로 와도 기간·필터·선택을 유지한다(같은 탭 세션, 계정별).
  const [filters, setFilters] = useViewState("insights:filters", initialFilters(today));
  const [dimension, setDimension] = useViewState<RatingDimension>(
      "insights:dimension",
      "category",
      ["category", "producer", "region", "price"],
    ),
    [ratingLabel, setRatingLabel] = useViewState("insights:rating-label", "");
  const [priceKey, setPriceKey] = useViewState("insights:price-key", "");
  const invalid = Boolean(filters.from && filters.to && filters.from > filters.to);
  const data = useMemo(
    () => (source?.data ? calculateInsights(source.data.snapshot, filters, today) : null),
    [source, filters, today],
  );
  if (!source) return <output>기기에 저장된 분석 기록을 불러오는 중…</output>;
  if (!data) return <p role="alert">{source.error}</p>;
  const ratings = data.ratings[dimension],
    selectedRating = ratings.find((row) => row.label === ratingLabel) ?? ratings[0];
  const price = data.prices.find((row) => row.key === priceKey) ?? data.prices[0];
  return (
    <div className="insights-dashboard">
      <p className="muted">
        {today} 기준 기기에 저장된 기록으로 계산합니다.
        {source.data?.pendingCount
          ? ` 동기화 대기 ${source.data.pendingCount}건(실패 ${source.data.failedCount}건)의 로컬 변경이 포함됩니다.`
          : ""}
      </p>
      <fieldset className="insight-filters">
        <legend>분석 범위</legend>
        <label>
          시작일
          <input
            type="date"
            value={filters.from}
            max={filters.to || today}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
          />
        </label>
        <label>
          종료일
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            max={today}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
          />
        </label>
        <label>
          주종 (하위 포함)
          <select
            value={filters.categoryId}
            onChange={(event) => setFilters({ ...filters, categoryId: event.target.value })}
          >
            <option value="">전체 주종</option>
            {data.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          대상 병의 현재 상태
          <select
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            <option value="all">전체 상태 · 병 없는 기록 포함</option>
            <option value="stock">현재 보유 (미개봉·개봉)</option>
            <option value="unopened">미개봉</option>
            <option value="open">개봉</option>
            <option value="finished">소진</option>
            <option value="gifted">증여</option>
            <option value="sold">판매</option>
          </select>
        </label>
        <div className="button-row">
          <button type="button" onClick={() => setFilters({ ...filters, from: "", to: today })}>
            날짜 있는 전체 기간
          </button>
          <button type="button" onClick={() => setFilters(initialFilters(today))}>
            최근 90일·전체로 초기화
          </button>
        </div>
      </fieldset>
      <p className="insight-scope">
        현재 재고와 제품 총평은 기간에 영향을 받지 않습니다. 기간은 구매일·시음일·최종
        소진/증여/판매일에 적용합니다. 상태를 고르면 그 현재 상태의 병과 연결된 기록만 분석하며,
        구매 금액은 선택된 병수×단가입니다. 과거 당시의 재고·상태를 추정하지 않습니다.
      </p>
      {invalid ? (
        <p role="alert">시작일은 종료일보다 늦을 수 없습니다. 기간을 다시 선택하세요.</p>
      ) : null}
      <section className="card" aria-labelledby="insight-stock">
        <h3 id="insight-stock">지금 보유한 술</h3>
        <dl className="metrics-grid metrics-grid--hero">
          <Metric
            label="현재 재고"
            value={`${data.inventory.bottles}병 · ${data.inventory.products}제품`}
          />
          <Metric
            label="미개봉 / 개봉"
            value={`${data.inventory.unopened} / ${data.inventory.opened}병`}
          />
          <Metric
            label="확인된 잔량"
            value={`${data.inventory.knownRemainingMl.toLocaleString("ko-KR")}ml`}
          />
          <Metric label="재고 원가 (SKU 실평단가 기준)" value={formatMoney(data.inventory.cost)} />
        </dl>
        <p className="muted">
          잔량 미확인 {data.inventory.unknownRemaining}병은 0ml로 합산하지 않았습니다. 미개봉은 규격
          용량 전량입니다. 원가는 SKU별 전체 구매의 가중 실평단가×현재 재고 병수로, 남은 양 비율로
          차감하지 않습니다. 기간·상태 필터는 실평단가의 구매 범위를 바꾸지 않습니다.
        </p>
        <BarChart
          title="현재 재고의 주종 구성"
          data={data.stockCategories.map((row) => ({ label: row.label, value: row.count }))}
          formatValue={(value) => `${value}병`}
        />
      </section>
      {!invalid ? (
        <section className="card" aria-labelledby="insight-events">
          <h3 id="insight-events">선택 기간의 변화</h3>
          <p>
            {filters.from || "기록 시작"} ~ {filters.to || "기록 끝"} · 날짜가 확인된 사건
          </p>
          <dl className="metrics-grid">
            <Metric
              label="구매"
              value={`${data.period.purchasedBottles}병 (${data.period.purchaseCount}건)`}
              testId="period-purchased"
            />
            <Metric label="지출 (기록된 원화 실구매가)" value={formatMoney(data.period.spend)} />
            <Metric label="소진" value={`${data.period.finished}병`} testId="period-finished" />
            <Metric label="증여 / 판매" value={`${data.period.gifted} / ${data.period.sold}병`} />
            <Metric label="시음 기록" value={`${data.period.tastings}회`} />
          </dl>
          {data.previous ? (
            <p className="muted">
              같은 길이의 직전 기간 ({data.previous.from} ~ {data.previous.to}): 구매{" "}
              {data.previous.purchasedBottles}병 · 소진 {data.previous.finished}병 · 지출{" "}
              {formatMoney(data.previous.spend)} · 시음 {data.previous.tastings}회. 서로 다른 제품과
              표본일 수 있습니다.
            </p>
          ) : (
            <p className="muted">시작일과 종료일이 있으면 같은 길이의 직전 기간과 비교합니다.</p>
          )}
          <p className="muted">
            증여·판매·소진은 현재 기록의 최종 종료일 기준입니다. 되돌린 과거 사건과 과거 재고는
            복원하지 않습니다. 실구매가 공란은 기존 정책대로 0원에 포함합니다.
          </p>
          <EvidenceList items={data.period.evidence} onSelectProduct={onSelectProduct} />
          <details>
            <summary>월별 구매·소진·지출</summary>
            <div className="table-scroll table-scroll--always">
              <table>
                <caption>기록이 있는 월 (선택 기간에 해당하는 날짜만)</caption>
                <thead>
                  <tr>
                    <th>월</th>
                    <th>구매 병수</th>
                    <th>소진 / 증여 / 판매</th>
                    <th>원화 지출</th>
                    <th>시음</th>
                  </tr>
                </thead>
                <tbody>
                  {data.monthly.map((month) => (
                    <tr key={month.month}>
                      <th>{month.month}</th>
                      <td>{month.purchasedBottles}</td>
                      <td>
                        {month.finished} / {month.gifted} / {month.sold}
                      </td>
                      <td>{formatMoney(month.spend)}</td>
                      <td>{month.tastings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      ) : null}
      <section className="card" aria-labelledby="insight-open">
        <h3 id="insight-open">열린 병의 경과</h3>
        <p>선택된 현재 개봉 병 {data.openBottles.length}병 · 날짜로 계산한 경과일입니다.</p>
        <BarChart
          title="개봉 경과일 분포"
          data={data.aging.map((row) => ({ label: row.label, value: row.count }))}
          formatValue={(value) => `${value}병`}
        />
        <EvidenceList
          preview
          items={data.openBottles.map((b) => ({
            ...b,
            detail: `개봉 ${b.openedDays === null ? "날짜 확인 필요" : `${b.openedDays}일 경과`} · ${b.remainingMl === null ? "잔량 미기록" : `${b.remainingMl}ml 남음`} · ${b.lastTastedOn ? `최근 시음 ${b.lastTastedOn} (${b.daysSinceTasting}일 전)` : "이 병의 시음 기록 없음"}`,
          }))}
          onSelectProduct={onSelectProduct}
        />
      </section>
      {!invalid ? (
        <section className="card" aria-labelledby="insight-recent">
          <h3 id="insight-recent">최근 시음</h3>
          <p>선택 기간과 현재 상태 범위의 시음 {data.recentTastings.length}회</p>
          <EvidenceList preview items={data.recentTastings} onSelectProduct={onSelectProduct} />
        </section>
      ) : null}
      {!invalid ? (
        <section className="card" aria-labelledby="insight-ratings">
          <h3 id="insight-ratings">평점과 표본</h3>
          <label>
            평점 묶음
            <select
              value={dimension}
              onChange={(event) => {
                setDimension(event.target.value as RatingDimension);
                setRatingLabel("");
              }}
            >
              {dimensions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {selectedRating ? (
            <>
              <label>
                평가 그룹
                <select
                  value={selectedRating.label}
                  onChange={(event) => setRatingLabel(event.target.value)}
                >
                  {ratings.map((row) => (
                    <option key={row.label} value={row.label}>
                      {row.label} · 제품 {row.products.count} / 시음 {row.sessions.count}
                    </option>
                  ))}
                </select>
              </label>
              <div className="insight-rating-columns">
                {(["products", "sessions"] as const).map((kind) => {
                  const result = selectedRating[kind],
                    label = kind === "products" ? "제품 총평" : "시음 평점";
                  return (
                    <div key={kind}>
                      <p>
                        <strong>{label}</strong>{" "}
                        {result.average === null ? "평가 없음" : `평균 ${result.average}점`} ·{" "}
                        {result.count}
                        {kind === "products" ? "개" : "회"}
                      </p>
                      {result.count > 0 ? (
                        <BarChart
                          title={`${label} 분포`}
                          data={result.bins
                            .map((count, index) => ({
                              label: index === 12 ? "6점" : `${index / 2}~${(index + 1) / 2} 미만`,
                              value: count,
                            }))
                            .filter((bin) => bin.value > 0)}
                          formatValue={(value) => `${value}${kind === "products" ? "개" : "회"}`}
                        />
                      ) : (
                        <p className="muted">평가를 남기면 이곳에서 분포를 비교할 수 있습니다.</p>
                      )}
                      <EvidenceList
                        label={`${label} 근거`}
                        items={result.evidence}
                        onSelectProduct={onSelectProduct}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="muted">
                제품 총평은 현재 평가 제품당 1개, 시음은 선택 기간의 평가 세션당 1개입니다. 0점은
                평가에 포함하고 평점 없음은 제외합니다. 분포는 평가가 있는 0.5점 구간만 표시합니다.
                표본이 적거나 같은 제품의 반복 시음이면 개인 취향 전체로 일반화할 수 없습니다.
              </p>
              {dimension === "price" ? (
                <p className="muted">
                  시음 가격대는 연결된 구매의 병당 원화 실구매가입니다. 제품은
                  규격·통화·조건·가격대가 하나로 확인될 때만 분류합니다. 통화와 기록된 조건이 다른
                  표본은 합치지 않습니다.
                </p>
              ) : null}
            </>
          ) : (
            <p>선택 범위에 평가한 제품이나 시음이 없습니다.</p>
          )}
        </section>
      ) : null}
      {!invalid ? (
        <section className="card" aria-labelledby="insight-price">
          <h3 id="insight-price">같은 규격의 구매 가격</h3>
          {price ? (
            <>
              <label>
                비교할 구매 묶음
                <select value={price.key} onChange={(event) => setPriceKey(event.target.value)}>
                  {data.prices.map((row) => (
                    <option key={row.key} value={row.key}>
                      {row.label} · {row.currency} · {row.condition} · {row.vendorKind} ·{" "}
                      {row.count}건
                    </option>
                  ))}
                </select>
              </label>
              <p>
                {price.label} · 원래 구매 통화 {price.currency} · {price.condition} ·{" "}
                {price.vendorKind}
              </p>
              <dl className="metrics-grid">
                <Metric
                  label="전체 구매 표본"
                  value={`${price.count}건 (0원·공란 ${price.zeroCount}건)`}
                />
                <Metric
                  label="유상 최저 병당 실구매가"
                  value={
                    price.paidMinimum === null ? "유상 표본 없음" : formatMoney(price.paidMinimum)
                  }
                />
                <Metric label="구매건별 중앙값" value={formatMoney(price.median)} />
                <Metric
                  label={`유상 구매 중앙값 (${price.paidCount}건)`}
                  value={
                    price.paidMedian === null ? "유상 표본 없음" : formatMoney(price.paidMedian)
                  }
                />
                <Metric
                  label={`최근 구매일 (${price.latestOn} · ${price.latestCount}건)`}
                  value={
                    price.latestMinimum === price.latestMaximum
                      ? formatMoney(price.latestMinimum)
                      : `${formatMoney(price.latestMinimum)} ~ ${formatMoney(price.latestMaximum)}`
                  }
                />
              </dl>
              <EvidenceList preview items={price.evidence} onSelectProduct={onSelectProduct} />
              <p className="muted">
                같은 SKU·통화·기록된 할인 조건·구매처 종류의 구매만 비교합니다. 모든 금액은 저장된
                병당 원화 실구매가이며 현재 환율로 바꾸지 않습니다. 중앙값은 병수 가중 없이 구매건별
                단가 기준입니다. 조건 미기록은 실제 조건이 같다는 뜻이 아닙니다.
              </p>
              {price.count < 2 ? <p>구매 표본이 1건이라 가격 변화는 비교할 수 없습니다.</p> : null}
            </>
          ) : (
            <p>선택 기간에 날짜가 확인된 구매가 없습니다.</p>
          )}
        </section>
      ) : null}
      <section className="card" aria-labelledby="insight-experience">
        <h3 id="insight-experience">보유 중 아직 시음 기록이 없는 제품</h3>
        <p>
          {data.untried.length}제품 · 제품의 전체 시음 기록 기준으로, 미개봉 여부와는 별개입니다.
        </p>
        <EvidenceList preview items={data.untried} onSelectProduct={onSelectProduct} />
        {!invalid ? (
          <>
            <p>
              선택 기간에 처음 시음한 병: 구매→첫 시음 중앙값{" "}
              {data.firstTasting.medianDays === null
                ? "계산 가능한 표본 없음"
                : `${data.firstTasting.medianDays}일`}{" "}
              · 구매일과 병 연결이 확인된 {data.firstTasting.count}병
            </p>
            <EvidenceList
              label="첫 시음 근거"
              items={data.firstTasting.evidence.map((item) => ({
                ...item,
                detail: `${item.detail} · 구매 후 ${item.days}일`,
              }))}
              onSelectProduct={onSelectProduct}
            />
          </>
        ) : null}
      </section>
      {!invalid ? (
        <section className="card" aria-labelledby="insight-change">
          <h3 id="insight-change">같은 제품의 반복 시음 평점</h3>
          <p className="muted">
            선택 기간에 평점이 2회 이상 있는 제품입니다. 처음·마지막 날짜에 여러 기록이 있으면 그날
            평균을 비교합니다. 원인이나 숙성 효과를 추정하지 않습니다.
          </p>
          {data.changes.length ? (
            data.changes.map((item) => (
              <details key={item.id}>
                <summary>
                  {item.label} · {item.count}회 ·{" "}
                  {item.delta === null
                    ? "같은 날짜라 선후 비교 없음"
                    : `${item.delta > 0 ? "+" : ""}${item.delta}점`}
                </summary>
                <p>
                  {item.firstOn}: {item.firstRating}점 → {item.lastOn}: {item.lastRating}점
                </p>
                <EvidenceList preview items={item.evidence} onSelectProduct={onSelectProduct} />
              </details>
            ))
          ) : (
            <p>반복 평가 표본이 없습니다.</p>
          )}
        </section>
      ) : null}
      <section className="card" aria-labelledby="insight-quality">
        <h3 id="insight-quality">분석을 제한하는 기록</h3>
        <p>지표마다 제외 이유를 따로 표시합니다. 한 기록은 여러 점검 항목에 해당할 수 있습니다.</p>
        {data.coverage
          .filter((item) => item.items.length)
          .map((item) => (
            <EvidenceList
              key={item.key}
              label={item.label}
              items={item.items}
              onSelectProduct={onSelectProduct}
            />
          ))}
        {!data.coverage.some((item) => item.items.length) ? (
          <p>현재 범위에서 확인할 누락 항목이 없습니다.</p>
        ) : null}
        {onOpenQuality ? (
          <button type="button" onClick={onOpenQuality}>
            데이터 품질에서 정리
          </button>
        ) : null}
      </section>
    </div>
  );
}
