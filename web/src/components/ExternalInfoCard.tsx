import { useMutation } from "@tanstack/react-query";
import { Fragment } from "react";
import { externalSourcesApi } from "@/api/client";
import type { SourceLookupResult } from "@/api/types";

/**
 * 등록된 외부 소스에서 평점·가격을 조회하는 카드(Task 18).
 *
 * `docs/architecture.md` §7.3 이 요구하는 "조회는 사용자 조작 시점에만" 규칙을 그대로
 * 따른다 — 이 카드는 마운트 시 아무것도 fetch 하지 않고, "조회" 버튼을 눌렀을 때만
 * `POST /products/{id}/external-lookup` 을 호출한다.
 *
 * 제품 상세와 매장 모드(Task 22 PR10) 양쪽에서 쓰여 별도 컴포넌트로 뽑았다 — 두 화면이
 * 완전히 같은 조회 UI 를 필요로 하는 실제 중복이다.
 */
export function ExternalInfoCard({ productId, offline }: { productId: string; offline: boolean }) {
  const lookup = useMutation({
    mutationFn: () => externalSourcesApi.lookup(productId),
  });

  return (
    <>
      <div className="section-header">
        <h3>외부 정보</h3>
        <button
          type="button"
          onClick={() => lookup.mutate()}
          disabled={offline || lookup.isPending}
        >
          {lookup.isPending ? "조회 중…" : "외부 정보 조회"}
        </button>
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
            <ExternalInfoResult key={result.source_id} result={result} />
          ))}
        </ul>
      )}
    </>
  );
}

function ExternalInfoResult({ result }: { result: SourceLookupResult }) {
  const fieldEntries = Object.entries(result.fields).filter(([, value]) => value !== null);

  return (
    <li className="external-info-item">
      <div className="external-info-header">
        <span className="name">{result.source_name}</span>
        {result.cached && <span className="muted text-sm">(캐시됨)</span>}
        {result.degraded && <span className="badge">일부 정보만 확인됨</span>}
      </div>

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
    </li>
  );
}
