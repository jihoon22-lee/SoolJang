import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { connectionsApi, externalSourcesApi, productsApi } from "@/api/client";
import {
  type ApplyField,
  type DiscoveryDocument,
  discoveryApi,
  type Evidence,
  type SourceMatch,
} from "@/api/discovery";
import { type Interest, type InterestIdentity, interestsApi } from "@/api/interests";
import type { Money, Product } from "@/api/types";
import { type DiscoveryJob, publicLink, useDiscovery } from "@/discovery/useDiscovery";
import { sourceOutcomeLabel } from "@/sourceOutcome";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { databaseIdentity } from "@/sync/db";
import { useDraftState } from "@/sync/drafts";
import { ExternalComparisonTable } from "./ExternalComparisonTable";
import { OfferComparison } from "./OfferComparison";

const fieldLabels: Record<ApplyField, string> = {
  name_en: "영문명",
  country: "국가",
  region: "지역",
  abv: "도수",
  vintage: "빈티지",
  age_years: "숙성 연수",
};
const kindLabels: Record<DiscoveryDocument["kind"], string> = {
  info: "제품 정보",
  review: "리뷰",
  seller_note: "판매자 설명",
  customer_tasting: "소비자 시음",
  service_review: "서비스 후기",
  unknown: "분류 미확인",
};
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString("ko-KR") : "미확인";
}
function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function DiscoveryPanel({
  productId,
  interest,
  initialName = "",
  offline = false,
  myPricePer100ml = null,
}: {
  productId?: string;
  interest?: Interest;
  initialName?: string;
  offline?: boolean;
  myPricePer100ml?: Money;
}) {
  const cache = useQueryClient();
  const formId = `discover-${interest?.id ?? productId ?? "new"}`;
  const [interestRevision, setInterestRevision] = useState(interest?.updated_at);
  const [form, setForm] = useDraftState(formId, {
    name: interest?.name ?? initialName,
    name_en: "",
    abv: "",
    vintage: "",
    age_years: "",
    volume: "",
    selections: [] as string[],
    requestId: "",
  });
  const [tab, setTab] = useState("info");
  const [domain, setDomain] = useState("");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("relevance");
  const [compare, setCompare] = useState<string[]>([]);
  const [matches, setMatches] = useState<Record<string, SourceMatch>>(
    interest?.source_matches ?? {},
  );
  const [saved, setSaved] = useState<string | null>(null);
  const composing = useRef(false);
  const { state, run, cancel, reset } = useDiscovery();
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    if (offline) cancelRef.current();
  }, [offline]);
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: ({ signal }) => connectionsApi.list(signal),
    enabled: !offline,
  });
  const sources = useQuery({
    queryKey: ["external-sources"],
    queryFn: ({ signal }) => externalSourcesApi.list(signal),
    enabled: !offline,
  });
  const product = useQuery({
    queryKey: ["discovery-product", productId],
    queryFn: ({ signal }) => productsApi.get(productId as string, signal),
    enabled: !!productId && !offline,
  });
  const context = useQuery({
    queryKey: ["discovery-context", productId],
    queryFn: ({ signal }) => discoveryApi.productContext(productId as string, signal),
    enabled: !!productId && !offline,
  });
  const currentMatches = { ...(context.data?.source_matches ?? {}), ...matches };
  const jobs: DiscoveryJob[] = [
    ...(connections.data ?? [])
      .filter(
        (row) =>
          row.is_active &&
          ["naver_hub", "naver_legacy", "brave", "exa"].includes(row.provider_kind),
      )
      .map((row) => ({ id: row.id, name: row.name, kind: "search" as const })),
    ...(sources.data ?? [])
      .filter((row) => row.is_active)
      .map((row) => ({ id: row.id, name: row.name, kind: "source" as const })),
  ];
  const identity = (): InterestIdentity =>
    interest?.identity ?? {
      name: form.name.trim(),
      name_en: form.name_en || product.data?.name_en || null,
      producer: product.data?.producer_name ?? null,
      abv: form.abv || product.data?.abv || null,
      vintage: form.vintage ? Number(form.vintage) : (product.data?.vintage ?? null),
      age_years: form.age_years || product.data?.age_years || null,
      volumes_ml: form.volume
        ? [Number(form.volume)]
        : (product.data?.skus.map((sku) => sku.volume_ml) ?? []),
    };
  const save = useMutation({
    mutationFn: async () => {
      const owner = databaseIdentity();
      const requestId = form.requestId || crypto.randomUUID();
      setForm((old) => ({ ...old, requestId }));
      const result = interest
        ? await interestsApi.update(interest.id, {
            expected_updated_at: interestRevision as string,
            source_matches: currentMatches,
          })
        : await discoveryApi.saveInterest(identity(), currentMatches, requestId);
      const now = databaseIdentity();
      if (now.userId !== owner.userId || now.generation !== owner.generation) return;
      setSaved(result.name);
      if (interest) setInterestRevision(result.updated_at);
      void cache.invalidateQueries({ queryKey: ["interests"] });
    },
  });
  const documents = state.documents
    .filter(
      (doc) =>
        (!domain || doc.domain === domain) &&
        (!kind || doc.kind === kind) &&
        (tab !== "review" ||
          ["review", "customer_tasting", "service_review", "seller_note"].includes(doc.kind)),
    )
    .sort((a, b) =>
      sort === "recent"
        ? (b.published_at ?? b.fetched_at).localeCompare(a.published_at ?? a.fetched_at)
        : sort === "domain"
          ? a.domain.localeCompare(b.domain)
          : 0,
    );
  const submit = () => {
    setSaved(null);
    setCompare([]);
    void run(
      identity(),
      jobs.filter((job) => form.selections.includes(job.id)),
      currentMatches,
      productId,
      interest?.id,
    );
  };
  return (
    <section className="discovery-panel" aria-label="술 탐색">
      <p className="muted">
        검색·전문 소스의 근거를 확인하고 관심 목록에 보관하세요. 관심 저장은 구매·재고를 늘리지
        않습니다.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!composing.current) submit();
        }}
      >
        <DraftRecoveryButton form={formId} />
        <label>
          검색할 술
          <input
            disabled={save.isPending}
            readOnly={!!interest}
            required
            maxLength={300}
            value={form.name}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || composing.current))
                event.preventDefault();
            }}
            onChange={(event) => {
              const name = event.target.value;
              reset();
              setMatches(interest?.source_matches ?? {});
              setSaved(null);
              setForm((old) => ({ ...old, name, requestId: "" }));
            }}
          />
        </label>
        <details>
          <summary>제품 식별 정보 (선택)</summary>
          <div className="discovery-fields">
            {(
              [
                ["name_en", "영문명"],
                ["abv", "도수"],
                ["vintage", "빈티지"],
                ["age_years", "숙성 연수"],
                ["volume", "용량 ml"],
              ] as const
            ).map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  disabled={save.isPending}
                  readOnly={!!interest}
                  value={form[field]}
                  type={field === "name_en" ? "text" : "number"}
                  min={field === "volume" ? 1 : 0}
                  step={field === "abv" || field === "age_years" ? "any" : 1}
                  onChange={(event) => {
                    const value = event.target.value;
                    reset();
                    setMatches(interest?.source_matches ?? {});
                    setSaved(null);
                    setForm((old) => ({ ...old, [field]: value, requestId: "" }));
                  }}
                />
              </label>
            ))}
          </div>
        </details>
        <fieldset disabled={offline}>
          <legend>조회할 검색 연결·전문 소스</legend>
          {jobs.map((job) => (
            <label className="discovery-choice" key={job.id}>
              <input
                type="checkbox"
                checked={form.selections.includes(job.id)}
                onChange={() =>
                  setForm((old) => ({ ...old, selections: toggle(old.selections, job.id) }))
                }
              />
              {job.name} · {job.kind === "search" ? "검색" : "전문 소스"}
            </label>
          ))}
          {!jobs.length && <p>활성 연결이 없습니다. 설정에서 연결을 추가하세요.</p>}
          <button
            type="button"
            onClick={() => {
              window.history.pushState(null, "", "#settings");
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          >
            연결 설정
          </button>
        </fieldset>
        {(connections.isError || sources.isError) && (
          <p role="alert">연결 목록을 불러오지 못했습니다. 설정 또는 네트워크를 확인하세요.</p>
        )}
        <div className="button-row">
          <button
            type="submit"
            disabled={
              offline || !form.name.trim() || !jobs.some((job) => form.selections.includes(job.id))
            }
          >
            {state.running ? "새로 검색" : "앱에서 검색"}
          </button>
          {state.running && (
            <button type="button" onClick={cancel}>
              조회 취소
            </button>
          )}
          <button
            type="button"
            disabled={
              offline ||
              !form.name.trim() ||
              save.isPending ||
              !!saved ||
              (!!productId && !context.data)
            }
            onClick={() => save.mutate()}
          >
            {interest ? "후보 고정 저장" : "관심에 저장"}
          </button>
        </div>
      </form>
      {offline && <output>오프라인입니다. 입력은 보관되며 온라인에서 검색할 수 있습니다.</output>}
      {saved && (
        <output>
          ‘{saved}’을 관심에 저장했습니다.{" "}
          <button
            type="button"
            onClick={() => {
              window.history.pushState(null, "", "#interests");
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          >
            관심 목록 보기
          </button>
        </output>
      )}
      {context.isError && (
        <p role="alert">기존 고정 정보를 불러오지 못했습니다. 관심 저장 전에 다시 조회하세요.</p>
      )}
      {save.isError && <p role="alert">{save.error.message}</p>}
      {state.total > 0 && (
        <output>
          {state.cancelled
            ? "조회 취소 · 완료된 결과 유지"
            : state.running
              ? "조회 중"
              : "조회 완료"}{" "}
          · {state.finished}/{state.total} · 검색 연결 {state.searchConnections}개 · 원문 도메인{" "}
          {new Set(state.documents.map((doc) => doc.domain)).size}개
        </output>
      )}
      {state.notices.map((notice) => (
        <p className="muted text-sm" key={notice}>
          {notice}
        </p>
      ))}
      <fieldset className="button-row" aria-label="결과 종류">
        {[
          ["info", "제품 정보"],
          ["price", "가격"],
          ["review", "평점·리뷰"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id as string)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {tab !== "price" && (
        <>
          <div className="discovery-fields">
            <label>
              출처 도메인
              <select value={domain} onChange={(event) => setDomain(event.target.value)}>
                <option value="">전체</option>
                {[...new Set(state.documents.map((doc) => doc.domain))].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              자료 구분
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="">전체</option>
                {Object.entries(kindLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              정렬
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="relevance">검색 순서</option>
                <option value="recent">최근 날짜</option>
                <option value="domain">출처</option>
              </select>
            </label>
          </div>
          {compare.length > 0 && (
            <div className="table-scroll">
              <table>
                <caption>선택 자료 비교</caption>
                <thead>
                  <tr>
                    <th>자료</th>
                    <th>근거</th>
                    <th>평점 (원척도)</th>
                    <th>게시일</th>
                  </tr>
                </thead>
                <tbody>
                  {state.documents
                    .filter((doc) => compare.includes(doc.url))
                    .map((doc) => (
                      <tr key={doc.url}>
                        <td>{doc.title}</td>
                        <td>
                          {doc.domain} · {kindLabels[doc.kind]}
                        </td>
                        <td>
                          {doc.rating ?? "미확인"} / {doc.rating_scale ?? "척도 미확인"} (
                          {doc.rating_count ?? "수 미확인"})
                        </td>
                        <td>{timestamp(doc.published_at)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="discovery-results">
            {documents.map((doc) => (
              <article className="discovery-result" key={doc.url}>
                <label>
                  <input
                    type="checkbox"
                    checked={compare.includes(doc.url)}
                    onChange={() => setCompare(toggle(compare, doc.url))}
                  />
                  비교 선택
                </label>
                <h3>
                  {publicLink(doc.url) ? (
                    <a href={publicLink(doc.url)} target="_blank" rel="noreferrer">
                      {doc.title}
                    </a>
                  ) : (
                    doc.title
                  )}
                </h3>
                <p className="muted text-sm">
                  {doc.domain} · {kindLabels[doc.kind]} ·{" "}
                  {doc.evidence === "search_excerpt" ? "검색 발췌" : "제공자 본문"}
                </p>
                <p>{doc.excerpt || "발췌 없음"}</p>
                <p className="text-sm">
                  게시 {timestamp(doc.published_at)} · 조회 {timestamp(doc.fetched_at)}
                </p>
                <p className="text-sm">발견: {doc.discovered_by.join(", ")}</p>
                {doc.rating !== null && (
                  <p>
                    평점 {doc.rating} / {doc.rating_scale ?? "척도 미확인"} ·{" "}
                    {doc.rating_count ?? "개수 미확인"}
                  </p>
                )}
                {product.data && (
                  <ApplyEvidence
                    key={`${doc.url}:${doc.evidence_token}`}
                    evidence={doc}
                    product={product.data}
                    offline={offline}
                    titleEvidence
                    onApplied={() => void cache.invalidateQueries()}
                  />
                )}
              </article>
            ))}
          </div>
          {!documents.length && state.total > 0 && !state.running && (
            <p>선택한 조건에 맞는 검색 자료가 없습니다.</p>
          )}
        </>
      )}
      {tab === "price" && productId && (
        <ExternalComparisonTable
          results={state.sources}
          productId={productId}
          offline={offline}
          myPricePer100ml={myPricePer100ml}
          onChanged={submit}
        />
      )}
      {tab === "price" && !productId && (
        <OfferComparison
          results={state.sources}
          productId={productId ?? ""}
          offline={offline || !productId}
          onChanged={submit}
        />
      )}
      {(tab === "price" && productId ? [] : state.sources).map((result) => (
        <article className="discovery-result" key={result.source_id}>
          <h3>
            {result.source_name} · {result.matched_name ?? "제품 미확인"}
          </h3>
          <p>
            {sourceOutcomeLabel(result.outcome ?? "unknown")}
            {result.cached ? " · 캐시" : ""}
            {result.degraded ? " · 부분 결과" : ""} · {timestamp(result.fetched_at)}
          </p>
          {result.warning && <output>{result.warning}</output>}
          {result.source_url && publicLink(result.source_url) && (
            <a href={publicLink(result.source_url)} target="_blank" rel="noreferrer">
              출처 보기
            </a>
          )}
          {tab === "review" && (
            <p>
              평점 {result.normalized.rating ?? "미확인"} /{" "}
              {result.normalized.rating_scale ?? "척도 미확인"} · 리뷰{" "}
              {result.normalized.review_count ?? "개수 미확인"}
            </p>
          )}
          {tab === "info" && <p>{result.raw_excerpt}</p>}
          {result.candidates.length > 0 && (
            <fieldset disabled={offline || save.isPending || !!saved}>
              <legend>같은 제품인지 확인하고 관심 후보 고정</legend>
              {result.candidates.map((candidate) => (
                <div key={candidate.url}>
                  <label>
                    <input
                      type="radio"
                      name={`pin-${result.source_id}`}
                      checked={currentMatches[result.source_id]?.external_url === candidate.url}
                      onChange={() => {
                        setMatches((old) => ({
                          ...old,
                          [result.source_id]: {
                            external_url: candidate.url,
                            external_name: candidate.name,
                            external_key: candidate.key,
                            product_key: candidate.product_key ?? null,
                          },
                        }));
                        setForm((old) => ({ ...old, requestId: "" }));
                      }}
                    />
                    {candidate.name}
                  </label>
                  <p className="text-sm">
                    {candidate.relationship ?? "대상 확인 필요"} ·{" "}
                    {[...(candidate.conflicts ?? []), ...(candidate.missing ?? [])].join(" · ")}
                  </p>
                  {publicLink(candidate.url) && (
                    <a href={publicLink(candidate.url)} target="_blank" rel="noreferrer">
                      후보 출처
                    </a>
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {product.data && (
            <ApplyEvidence
              key={`${result.source_id}:${result.evidence_token}`}
              evidence={result}
              product={product.data}
              offline={offline}
              onApplied={() => void cache.invalidateQueries()}
            />
          )}
        </article>
      ))}
      <details>
        <summary>외부 브라우저에서 보조 검색</summary>
        <a
          href={`https://www.google.com/search?q=${encodeURIComponent(form.name)}`}
          target="_blank"
          rel="noreferrer"
        >
          Google에서 검색
        </a>
      </details>
    </section>
  );
}
function ApplyEvidence({
  evidence,
  product,
  offline,
  titleEvidence = false,
  onApplied,
}: {
  evidence: Evidence;
  product: Product;
  offline: boolean;
  titleEvidence?: boolean;
  onApplied: () => void;
}) {
  const [snapshot] = useState(product);
  const revision = snapshot.updated_at;
  const [selected, setSelected] = useState<string[]>([]);
  const apply = useMutation({
    mutationFn: () =>
      discoveryApi.apply(
        product.id,
        revision,
        evidence.evidence_token as string,
        selected as ApplyField[],
      ),
    onSuccess: onApplied,
  });
  if (!evidence.evidence_token || !Object.keys(evidence.applicable_fields ?? {}).length)
    return null;
  return (
    <details>
      <summary>제품 정보 비교·선택 적용</summary>
      {titleEvidence && <p>제목에서 추출·적용 전 대상 확인</p>}
      <p>동일한 제품·판본인지 출처에서 확인하세요. 선택한 필드만 적용됩니다.</p>
      <fieldset disabled={offline || apply.isPending || apply.isSuccess}>
        {Object.entries(fieldLabels).map(([field, label]) => (
          <label className="discovery-choice" key={field}>
            <input
              type="checkbox"
              disabled={evidence.applicable_fields?.[field as ApplyField] === undefined}
              checked={selected.includes(field)}
              onChange={() => setSelected(toggle(selected, field))}
            />
            {label}: {snapshot[field as ApplyField] ?? "없음"} →{" "}
            {evidence.applicable_fields?.[field as ApplyField] ?? "근거 없음"}
          </label>
        ))}
        <button type="button" disabled={!selected.length} onClick={() => apply.mutate()}>
          선택한 정보 적용
        </button>
      </fieldset>
      {apply.isError && (
        <p role="alert">{apply.error.message} 최신 제품을 다시 확인한 뒤 새로 조회하세요.</p>
      )}
      {apply.isSuccess && <output>선택한 정보를 적용했습니다.</output>}
    </details>
  );
}
