import { useMutation } from "@tanstack/react-query";
import { Fragment } from "react";
import { externalSourcesApi } from "@/api/client";
import type { LookupCandidate, SourceLookupResult } from "@/api/types";

/**
 * 등록된 외부 소스에서 평점·가격을 조회하는 카드(Task 18).
 *
 * `docs/architecture.md` §7.3 이 요구하는 "조회는 사용자 조작 시점에만" 규칙을 그대로
 * 따른다 — 이 카드는 마운트 시 아무것도 fetch 하지 않고, "조회" 버튼을 눌렀을 때만
 * `POST /products/{id}/external-lookup` 을 호출한다.
 *
 * 제품 상세와 매장 모드(Task 22 PR10) 양쪽에서 쓰여 별도 컴포넌트로 뽑았다 — 두 화면이
 * 완전히 같은 조회 UI 를 필요로 하는 실제 중복이다.
 *
 * **매칭 고정(Task 34 PR1, §7.4)**: `needs_confirmation` 이면 후보 목록을 펼쳐 사용자가
 * 직접 고르게 한다. "이걸로 고정"을 누르면 `POST .../external-matches` 호출 뒤 조회를
 * 다시 실행한다(고정 기준으로 값이 바뀌었을 수 있어서다) — `useQuery` 가 아니라
 * `useMutation` 을 쓰는 기존 구조라 캐시 무효화 대신 직접 재호출한다.
 */
export function ExternalInfoCard({
  productId,
  productName,
  offline,
}: {
  productId: string;
  productName: string;
  offline: boolean;
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
      )}
    </>
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
  const fieldEntries = Object.entries(result.fields).filter(([, value]) => value !== null);

  const pin = useMutation({
    mutationFn: (candidate: LookupCandidate) =>
      externalSourcesApi.pin(productId, {
        source_id: result.source_id,
        external_url: candidate.url,
        external_name: candidate.name,
        external_key: candidate.key,
      }),
    onSuccess: onChanged,
  });
  const unpin = useMutation({
    mutationFn: () => externalSourcesApi.unpin(productId, result.source_id),
    onSuccess: onChanged,
  });

  return (
    <li className="external-info-item">
      <div className="external-info-header">
        <span className="name">{result.source_name}</span>
        {result.cached && <span className="muted text-sm">(캐시됨)</span>}
        {result.degraded && <span className="badge">일부 정보만 확인됨</span>}
        {result.pinned && <span className="badge">고정됨</span>}
      </div>

      {result.needs_confirmation && (
        <output className="muted text-sm" aria-live="polite">
          확인이 필요합니다 — 아래 후보 중 맞는 것을 골라 "이걸로 고정"을 눌러 주세요.
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

      {result.source_url && (
        <a href={result.source_url} target="_blank" rel="noreferrer">
          출처 보기
        </a>
      )}

      {result.pinned ? (
        <div className="button-row">
          <button
            type="button"
            onClick={() => unpin.mutate()}
            disabled={offline || unpin.isPending}
          >
            {unpin.isPending ? "해제 중…" : "고정 해제"}
          </button>
        </div>
      ) : (
        result.candidates.length > 0 && (
          <details className="candidate-list" open={result.needs_confirmation}>
            <summary>후보 {result.candidates.length}개</summary>
            <ul>
              {result.candidates.map((candidate) => (
                <li key={candidate.url} className="candidate-row">
                  <span className="candidate-name">{candidate.name}</span>
                  <span className="muted text-sm">{Math.round(candidate.score * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => pin.mutate(candidate)}
                    disabled={offline || pin.isPending}
                  >
                    이걸로 고정
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )
      )}
    </li>
  );
}
