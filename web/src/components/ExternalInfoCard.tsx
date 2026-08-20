import { useMutation } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { externalSourcesApi } from "@/api/client";
import type { LookupCandidate, SourceLookupResult } from "@/api/types";

/**
 * 등록된 외부 소스에서 평점·가격을 조회하는 카드(Task 18, Task 34 PR1).
 *
 * `docs/architecture.md` §7.3 이 요구하는 "조회는 사용자 조작 시점에만" 규칙을 그대로
 * 따른다 — 이 카드는 마운트 시 아무것도 fetch 하지 않고, "조회" 버튼을 눌렀을 때만
 * `POST /products/{id}/external-lookup` 을 호출한다.
 *
 * 제품 상세와 매장 모드(Task 22 PR10) 양쪽에서 쓰여 별도 컴포넌트로 뽑았다 — 두 화면이
 * 완전히 같은 조회 UI 를 필요로 하는 실제 중복이다.
 *
 * Task 34 PR1 에서 **매칭을 보여주고 고칠 수 있게** 바뀌었다. 이름 유사도는 100% 가 될 수
 * 없으므로, 무엇에 매칭됐는지를 늘 보여주고 확신이 낮으면 후보를 함께 펼쳐 사용자가
 * 고르게 한다. 한 번 고르면 그 제품은 이후 조회에서 영구히 정확해진다.
 */
export function ExternalInfoCard({
  productId,
  productName,
  offline,
  myPricePer100ml = null,
}: {
  productId: string;
  productName: string;
  offline: boolean;
  /** 내 실평단가 기준 100ml당 가격. 있으면 소스 가격과의 차이를 함께 보여준다. */
  myPricePer100ml?: string | null;
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
        <>
          <ComparisonTable results={lookup.data} myPricePer100ml={myPricePer100ml} />
          <ul className="external-info-list">
            {lookup.data.map((result) => (
              <ExternalInfoResult
                key={result.source_id}
                result={result}
                productId={productId}
                offline={offline}
                onChanged={() => lookup.mutate()}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

const DASH = "—";

function formatWon(value: number | null): string {
  return value === null ? DASH : `${Math.round(value).toLocaleString("ko-KR")}원`;
}

/**
 * 소스별 값을 나란히 놓는 비교 표(Task 34 PR3).
 *
 * 소스가 여럿이 되면 카드를 훑어서는 어디가 싼지 알 수 없다. 100ml당 가격으로 환산해
 * 용량이 다른 상품끼리도 비교되게 하고, 내 실평단가와의 차이를 함께 보여준다 —
 * "내가 산 가격보다 12% 비쌈" 이 이 기능의 실질 가치다.
 */
function ComparisonTable({
  results,
  myPricePer100ml,
}: {
  results: SourceLookupResult[];
  myPricePer100ml: string | null;
}) {
  const priced = results.filter((result) => typeof result.fields.price_krw === "number");
  // 가격이 하나뿐이면 "최저가" 배지가 아무 정보도 주지 않는다.
  const lowest =
    priced.length > 1
      ? Math.min(...priced.map((result) => result.fields.price_krw as number))
      : null;
  const mine = myPricePer100ml === null ? null : Number(myPricePer100ml);

  return (
    <div className="table-scroll">
      <table className="external-compare">
        <thead>
          <tr>
            <th>소스</th>
            <th>가격</th>
            <th>100ml당</th>
            <th>내 단가 대비</th>
            <th>평점</th>
            <th>재고</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const price =
              typeof result.fields.price_krw === "number" ? result.fields.price_krw : null;
            const per100 = result.price_per_100ml;
            const delta =
              mine !== null && per100 !== null && mine > 0
                ? Math.round(((per100 - mine) / mine) * 100)
                : null;
            return (
              <tr key={result.source_id}>
                <td>
                  {result.source_name}
                  {result.degraded && (
                    <span className="badge" title={result.warning ?? "일부 정보만 확인됨"}>
                      !
                    </span>
                  )}
                </td>
                <td>
                  {formatWon(price)}
                  {lowest !== null && price === lowest && <span className="badge">최저</span>}
                </td>
                <td>{formatWon(per100)}</td>
                <td>{delta === null ? DASH : `${delta > 0 ? "+" : ""}${delta}%`}</td>
                <td>
                  {result.rating_normalized === null
                    ? DASH
                    : `${result.rating_normalized.toFixed(1)}/5`}
                </td>
                <td>
                  {result.fields.in_stock === true
                    ? "있음"
                    : result.fields.in_stock === false
                      ? "없음"
                      : DASH}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExternalInfoResult({
  result,
  productId,
  offline,
  onChanged,
}: {
  result: SourceLookupResult;
  productId: string;
  offline: boolean;
  onChanged: () => void;
}) {
  const fieldEntries = [...Object.entries(result.fields), ...Object.entries(result.extra)].filter(
    ([, value]) => value !== null && value !== undefined,
  );
  // 확신이 낮을 때만 후보를 펼쳐 둔다. 자동 채택된 결과까지 펼치면 카드가 길어지기만 한다.
  const [candidatesOpen, setCandidatesOpen] = useState(result.needs_confirmation);

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
    <li className="external-info-item">
      <div className="external-info-header">
        <span className="name">{result.source_name}</span>
        {result.cached && <span className="muted text-sm">(캐시됨)</span>}
        {result.pinned && <span className="badge">고정됨</span>}
        {result.degraded && <span className="badge">일부 정보만 확인됨</span>}
      </div>

      {result.matched_name && (
        <p className="muted text-sm">
          매칭: {result.matched_name}
          {result.match_score !== null && ` (유사도 ${Math.round(result.match_score * 100)}%)`}
        </p>
      )}

      {result.needs_confirmation && (
        <output className="notice text-sm">
          이 술이 맞는지 확인해 주세요. 아래 후보 중에서 고르면 다음부터는 그대로 조회합니다.
        </output>
      )}

      {fieldEntries.length > 0 && (
        <dl className="external-info-fields">
          {fieldEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="muted">{key}</dt>
              <dd>{String(value)}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      {result.warning && <p className="muted text-sm">{result.warning}</p>}

      <div className="button-row">
        {result.source_url && (
          <a href={result.source_url} target="_blank" rel="noreferrer">
            출처 보기
          </a>
        )}
        {result.pinned && (
          <button type="button" onClick={() => unpin.mutate()} disabled={busy}>
            고정 해제
          </button>
        )}
        {result.candidates.length > 0 && !result.needs_confirmation && (
          <button type="button" onClick={() => setCandidatesOpen((open) => !open)}>
            {candidatesOpen ? "후보 접기" : "다른 후보 보기"}
          </button>
        )}
      </div>

      {candidatesOpen && result.candidates.length > 0 && (
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
          고정에 실패했습니다: {pin.error instanceof Error ? pin.error.message : "알 수 없는 오류"}
        </p>
      )}
    </li>
  );
}
