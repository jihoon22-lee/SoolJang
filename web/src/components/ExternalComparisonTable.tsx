import { useMutation } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { externalSourcesApi } from "@/api/client";
import type { LookupCandidate, Money, SourceLookupResult } from "@/api/types";
import { formatMoney } from "@/format";
import { sourceOutcomeLabel } from "@/sourceOutcome";
import { OfferComparison } from "./OfferComparison";

function toNumber(money: Money): number | null {
  if (money === null) return null;
  const value = Number(money);
  return Number.isNaN(value) ? null : value;
}

function formatFetchedAt(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function ExternalComparisonTable({
  results,
  productId,
  offline,
  myPricePer100ml,
  onChanged,
}: {
  results: SourceLookupResult[];
  productId: string;
  offline: boolean;
  myPricePer100ml: Money;
  onChanged: () => void;
}) {
  const myPrice = toNumber(myPricePer100ml);

  return (
    <>
      <OfferComparison
        results={results}
        productId={productId}
        offline={offline}
        onChanged={onChanged}
      />
      <div className="table-scroll table-scroll--always">
        <table className="stats-table external-compare-table">
          <thead>
            <tr>
              <th scope="col">소스</th>
              <th scope="col">가격</th>
              <th scope="col">100ml당</th>
              <th scope="col">평점</th>
              <th scope="col">재고</th>
              <th scope="col">확인</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const per100 = toNumber(result.normalized.price_per_100ml);
              return (
                <ExternalInfoRow
                  key={result.source_id}
                  result={result}
                  deltaPercent={
                    per100 !== null && myPrice !== null && myPrice > 0
                      ? Math.round(((per100 - myPrice) / myPrice) * 100)
                      : null
                  }
                  productId={productId}
                  offline={offline}
                  onChanged={onChanged}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ExternalInfoRow({
  result,
  deltaPercent,
  productId,
  offline,
  onChanged,
}: {
  result: SourceLookupResult;
  deltaPercent: number | null;
  productId: string;
  offline: boolean;
  onChanged: () => void;
}) {
  const { normalized } = result;
  // 확신이 낮거나(다음 조치가 필요) 이미 고정돼(해제 버튼이 필요) 있으면 펼쳐 둔다.
  // 그 밖에는 접어 둬 표가 길어지지 않게 한다.
  const [detailOpen, setDetailOpen] = useState(result.needs_confirmation || result.pinned);
  const extraEntries = Object.entries(normalized.extra).filter(([, value]) => value !== null);

  const pin = useMutation({
    mutationFn: (candidate: LookupCandidate) =>
      externalSourcesApi.pinMatch(productId, {
        source_id: result.source_id,
        external_url: candidate.url,
        external_name: candidate.name,
        external_key: candidate.key,
        external_product_key: candidate.product_key ?? null,
      }),
    onSuccess: onChanged,
  });
  const unpin = useMutation({
    mutationFn: () => externalSourcesApi.unpinMatch(productId, result.source_id),
    onSuccess: onChanged,
  });
  const busy = offline || pin.isPending || unpin.isPending;

  return (
    <Fragment>
      <tr className="external-compare-row">
        <td>
          <span className="name">{result.source_name}</span>
          {result.cached && <span className="muted text-sm"> (캐시됨)</span>}
          {result.pinned && <span className="badge">고정됨</span>}
          {result.degraded && (
            <span className="badge" title={result.warning ?? undefined}>
              일부 정보만 확인됨
            </span>
          )}
          {result.warning && <p className="muted text-sm">{result.warning}</p>}
          {result.source_url && (
            <div>
              <a href={result.source_url} target="_blank" rel="noreferrer">
                출처 보기
              </a>
            </div>
          )}
        </td>
        <td className="numeric">
          {formatMoney(numberToMoney(normalized.price_krw), { short: true })}
        </td>
        <td className="numeric">
          {formatMoney(normalized.price_per_100ml, { short: true })}
          {deltaPercent !== null && (
            <div className="muted text-sm">
              내 가격 대비 {deltaPercent > 0 ? "+" : ""}
              {deltaPercent}%
            </div>
          )}
        </td>
        <td className="numeric">
          {normalized.rating_normalized !== null
            ? `${normalized.rating_normalized} / 5`
            : normalized.rating !== null
              ? String(normalized.rating)
              : "—"}
        </td>
        <td>{normalized.in_stock === null ? "—" : normalized.in_stock ? "있음" : "품절"}</td>
        <td>
          <span className="muted text-sm">{formatFetchedAt(result.fetched_at)}</span>
          {(result.needs_confirmation ||
            result.candidates.length > 0 ||
            result.pinned ||
            result.matched_name !== null ||
            extraEntries.length > 0) && (
            <button type="button" onClick={() => setDetailOpen((open) => !open)}>
              {detailOpen ? "접기" : "상세"}
            </button>
          )}
        </td>
      </tr>

      {detailOpen && (
        <tr className="external-compare-detail">
          <td colSpan={6}>
            {result.outcome && (
              <p className="muted text-sm">조회 상태: {sourceOutcomeLabel(result.outcome)}</p>
            )}
            {result.matched_name && (
              <p className="muted text-sm">
                매칭: {result.matched_name}
                {result.match_score !== null &&
                  ` (일치 지표 ${Math.round(result.match_score * 100)}점)`}
              </p>
            )}
            {result.needs_confirmation && (
              <output className="notice text-sm">
                이 술이 맞는지 확인해 주세요. 아래 후보 중에서 고르면 다음부터는 그대로 조회합니다.
              </output>
            )}

            {extraEntries.length > 0 && (
              <dl className="external-info-fields">
                {extraEntries.map(([key, value]) => (
                  <Fragment key={key}>
                    <dt className="muted">{key}</dt>
                    <dd>{String(value)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}

            {result.pinned && (
              <div className="button-row">
                <button type="button" onClick={() => unpin.mutate()} disabled={busy}>
                  고정 해제
                </button>
              </div>
            )}

            {result.candidates.length > 0 && (
              <ul className="external-candidate-list">
                {result.candidates.map((candidate) => (
                  <li key={candidate.url} className="external-candidate">
                    <span className="name">{candidate.name}</span>
                    <span className="muted text-sm">{Math.round(candidate.score * 100)}점</span>
                    {!!candidate.conflicts?.length && (
                      <span className="badge">불일치: {matchFacts(candidate.conflicts)}</span>
                    )}
                    {!!candidate.missing?.length && (
                      <span className="muted text-sm">
                        확인 필요: {matchFacts(candidate.missing)}
                      </span>
                    )}
                    {/* LLM 재판정 추천(Task 34 PR6) — 배지만 붙일 뿐 자동으로 고정하지
                        않는다. "이걸로 고정" 은 다른 후보와 똑같이 사용자가 눌러야 한다. */}
                    {result.llm_recommended_url === candidate.url && (
                      <span className="badge">LLM 추천</span>
                    )}
                    <button type="button" onClick={() => pin.mutate(candidate)} disabled={busy}>
                      이걸로 고정
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {pin.isError && (
              <p className="alert" role="alert">
                고정에 실패했습니다:{" "}
                {pin.error instanceof Error ? pin.error.message : "알 수 없는 오류"}
              </p>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

const MATCH_FACT_LABELS: Record<string, string> = {
  volume_ml: "용량",
  age_years: "숙성 연수",
  abv: "도수",
  vintage: "빈티지",
  batch: "배치",
  cask: "캐스크",
  packaging: "세트·수량",
  producer: "생산자",
  detail_volume_ml: "상세 용량",
  detail_age_years: "상세 숙성 연수",
  detail_abv: "상세 도수",
  detail_vintage: "상세 빈티지",
};
function matchFacts(keys: string[]) {
  return keys.map((key) => MATCH_FACT_LABELS[key] ?? key).join(", ");
}

function numberToMoney(value: number | null): Money {
  return value === null ? null : String(value);
}
