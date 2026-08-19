import { useMutation } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { externalSourcesApi } from "@/api/client";
import type { LookupCandidate, Money, SourceLookupResult } from "@/api/types";
import { formatMoney } from "@/format";

/**
 * 등록된 외부 소스에서 평점·가격을 조회하는 카드(Task 18, Task 34 PR1·PR3).
 *
 * `docs/architecture.md` §7.3 이 요구하는 "조회는 사용자 조작 시점에만" 규칙을 그대로
 * 따른다 — 이 카드는 마운트 시 아무것도 fetch 하지 않고, "조회" 버튼을 눌렀을 때만
 * `POST /products/{id}/external-lookup` 을 호출한다.
 *
 * 제품 상세와 매장 모드(Task 22 PR10) 양쪽에서 쓰여 별도 컴포넌트로 뽑았다 — 두 화면이
 * 완전히 같은 조회 UI 를 필요로 하는 실제 중복이다.
 *
 * Task 34 PR3 에서 소스별 카드 나열을 **표 하나**로 바꿨다 — 소스가 하나뿐일 때는 카드로도
 * 충분했지만, 여럿이 되면 "어디가 더 싼지"를 한눈에 비교할 방법이 없었다(계획서 진단 8번).
 * `normalized.price_per_100ml` 로 최저가를 표시하고, `myPricePer100ml` 을 주면 내 실평단가
 * 대비 델타도 함께 보여준다.
 */
export function ExternalInfoCard({
  productId,
  productName,
  offline,
  myPricePer100ml,
}: {
  productId: string;
  productName: string;
  offline: boolean;
  /** 내 실평단가(100ml당). 있으면 소스별 가격과의 델타를 함께 보여준다(Task 34 PR3). */
  myPricePer100ml?: Money;
}) {
  const lookup = useMutation({
    mutationFn: () => externalSourcesApi.lookup(productId),
  });

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(productName)}`;

  return (
    <>
      <div className="section-header">
        <h3>외부 정보</h3>
        <div className="button-row">
          {/* 등록된 소스가 없는 술도 직접 확인할 수 있게 — 브라우저 검색을 새 탭으로 연다.
              스크래핑·LLM 없이 제로 리스크인 "외부에서 찾기" 경로다. */}
          <a href={searchUrl} target="_blank" rel="noreferrer">
            웹에서 검색
          </a>
          <button
            type="button"
            onClick={() => lookup.mutate()}
            disabled={offline || lookup.isPending}
          >
            {lookup.isPending ? "조회 중…" : "외부 정보 조회"}
          </button>
        </div>
      </div>
      {offline && <p className="muted text-sm">외부 정보 조회는 온라인일 때만 할 수 있습니다.</p>}

      {lookup.isError && (
        <p className="alert" role="alert">
          조회에 실패했습니다:{" "}
          {lookup.error instanceof Error ? lookup.error.message : "알 수 없는 오류"}
        </p>
      )}

      {lookup.isSuccess && lookup.data.length === 0 && (
        <output className="notice">
          등록된 외부 소스가 없습니다. 설정의 "외부 소스"에서 조회할 사이트를 등록하세요.
        </output>
      )}

      {lookup.isSuccess && lookup.data.length > 0 && (
        <ExternalComparisonTable
          results={lookup.data}
          productId={productId}
          offline={offline}
          myPricePer100ml={myPricePer100ml ?? null}
          onChanged={() => lookup.mutate()}
        />
      )}
    </>
  );
}

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

function ExternalComparisonTable({
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
  const per100Values = results
    .map((result) => toNumber(result.normalized.price_per_100ml))
    .filter((value): value is number => value !== null);
  const lowest = per100Values.length > 0 ? Math.min(...per100Values) : null;
  const myPrice = toNumber(myPricePer100ml);

  return (
    <div className="table-scroll">
      <table className="external-compare-table">
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
                isLowest={lowest !== null && per100 === lowest}
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
  );
}

function ExternalInfoRow({
  result,
  isLowest,
  deltaPercent,
  productId,
  offline,
  onChanged,
}: {
  result: SourceLookupResult;
  isLowest: boolean;
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
          {isLowest && <span className="badge">최저</span>}
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
            {result.matched_name && (
              <p className="muted text-sm">
                매칭: {result.matched_name}
                {result.match_score !== null &&
                  ` (유사도 ${Math.round(result.match_score * 100)}%)`}
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
                    <span className="muted text-sm">{Math.round(candidate.score * 100)}%</span>
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

function numberToMoney(value: number | null): Money {
  return value === null ? null : String(value);
}
