import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useState } from "react";

import { ApiError, externalSourcesApi } from "@/api/client";
import type { ExternalSource, ExternalSourceInput } from "@/api/types";
import { formatCategoryPath } from "@/format";
import { getCategoryTree } from "@/sync/queries";

interface SourceFormState {
  name: string;
  baseUrl: string;
  categoryId: string;
  priority: string;
  isActive: boolean;
  rateLimitPerMin: string;
  ttlHours: string;
  note: string;
  adapterSpecText: string;
}

const EXAMPLE_ADAPTER_SPEC = `{
  "search": {
    "url_template": "https://example.com/search?q={query}",
    "item": ".product-card",
    "fields": {
      "name": { "selector": ".title", "attr": "text" },
      "url": { "selector": "a", "attr": "href", "absolute": true }
    }
  },
  "detail": {
    "fields": {
      "price": { "selector": ".price", "attr": "text", "transform": ["strip_currency", "to_number"] },
      "rating": { "selector": ".rating", "attr": "text", "transform": ["to_number"] }
    }
  }
}`;

const EMPTY_FORM: SourceFormState = {
  name: "",
  baseUrl: "",
  categoryId: "",
  priority: "0",
  isActive: true,
  rateLimitPerMin: "6",
  ttlHours: "24",
  note: "",
  adapterSpecText: EXAMPLE_ADAPTER_SPEC,
};

function formToInput(form: SourceFormState): ExternalSourceInput | { error: string } {
  let adapter_spec: Record<string, unknown>;
  try {
    adapter_spec = JSON.parse(form.adapterSpecText);
  } catch {
    return { error: "adapter_spec 이 올바른 JSON이 아닙니다" };
  }
  return {
    name: form.name.trim(),
    base_url: form.baseUrl.trim(),
    adapter_spec,
    category_id: form.categoryId || null,
    priority: Number(form.priority) || 0,
    is_active: form.isActive,
    rate_limit_per_min: Number(form.rateLimitPerMin) || 6,
    ttl_hours: Number(form.ttlHours) || 24,
    note: form.note.trim() || null,
  };
}

function sourceToForm(source: ExternalSource): SourceFormState {
  return {
    name: source.name,
    baseUrl: source.base_url,
    categoryId: source.category_id ?? "",
    priority: String(source.priority),
    isActive: source.is_active,
    rateLimitPerMin: String(source.rate_limit_per_min),
    ttlHours: String(source.ttl_hours),
    note: source.note ?? "",
    adapterSpecText: JSON.stringify(source.adapter_spec, null, 2),
  };
}

/**
 * 외부 소스 레지스트리 관리 화면(Task 18).
 *
 * `adapter` 전략(§7.2)만 등록한다 — `search` 전략(구글 검색 스크래핑)은 별도 PR 로 미뤘다.
 * `adapter_spec` 은 사이트마다 셀렉터 구조가 완전히 달라 전용 폼 대신 JSON 원문을 직접
 * 편집한다 — 이 화면은 앱 소유자가 사이트 하나를 등록할 때만 쓰는 관리 기능이라, 일반
 * 사용자 입력 폼만큼 매끄러울 필요가 없다.
 *
 * 아래 예시는 서버가 HTML 을 그대로 내려주는 사이트용(CSS 셀렉터, `format` 생략 시 기본값
 * `html`)이다. Next.js 등 SPA 사이트는 검색 결과 페이지의 원본 HTML 에 상품 정보가 없는
 * 경우가 많다 — 이때는 `format: "json"` 모드로 등록한다(§7.2 "JSON 모드" 참조, 데일리샷이
 * 실제 등록 사례다).
 *
 * 서버 전용 데이터라(`LlmSetting` 과 같은 이유로 동기화 대상이 아니다) `enqueue()` 오프라인
 * 경로 대신 `externalSourcesApi` 를 직접 호출한다.
 */
export function SourcesPage() {
  const queryClient = useQueryClient();
  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const sources = useQuery({
    queryKey: ["external-sources"],
    queryFn: ({ signal }) => externalSourcesApi.list(signal),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SourceFormState>(EMPTY_FORM);
  const [localError, setLocalError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["external-sources"] });

  const create = useMutation({
    mutationFn: (input: ExternalSourceInput) => externalSourcesApi.create(input),
    onSuccess: () => {
      setForm(EMPTY_FORM);
      void invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (input: { id: string; patch: ExternalSourceInput }) =>
      externalSourcesApi.update(input.id, input.patch),
    onSuccess: () => {
      setEditingId(null);
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => externalSourcesApi.remove(id),
    onSuccess: () => void invalidate(),
  });

  function startEdit(source: ExternalSource): void {
    setEditingId(source.id);
    setForm(sourceToForm(source));
    setLocalError(null);
    update.reset();
  }

  function startCreate(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setLocalError(null);
    create.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setLocalError("이름과 사이트 주소를 입력하세요");
      return;
    }
    const result = formToInput(form);
    if ("error" in result) {
      setLocalError(result.error);
      return;
    }
    setLocalError(null);
    if (editingId) {
      update.mutate({ id: editingId, patch: result });
    } else {
      create.mutate(result);
    }
  }

  const mutationError = editingId ? update.error : create.error;
  const errorMessage =
    localError ??
    (mutationError instanceof ApiError
      ? mutationError.message
      : mutationError instanceof Error
        ? mutationError.message
        : null);
  const categories = categoryTree?.items ?? [];
  const isSaving = create.isPending || update.isPending;

  return (
    <section aria-labelledby="sources-heading" className="panel">
      <h2 id="sources-heading">외부 소스 관리</h2>
      <p className="muted">
        등록한 사이트에서 술 평점·가격을 조회합니다. 조회는 제품 상세에서 버튼을 눌렀을 때만
        일어납니다 — 이 화면에서는 사이트 목록과 파싱 규칙(`adapter_spec`)만 관리합니다.
      </p>

      {sources.isPending && <output aria-live="polite">불러오는 중…</output>}

      {sources.data && sources.data.length > 0 && (
        <ul className="vendor-list">
          {sources.data.map((source) => (
            <li className="vendor-row" key={source.id}>
              <span className="name">{source.name}</span>
              <span className="muted">{source.base_url}</span>
              <span className="muted">{source.is_active ? "활성" : "비활성"}</span>
              <span className="muted">우선순위 {source.priority}</span>
              <span className="muted">
                {source.category_id
                  ? formatCategoryPath(
                      categories.find((c) => c.id === source.category_id)?.path ?? [],
                    )
                  : "전체 주종"}
              </span>
              <div className="button-row">
                <button type="button" onClick={() => startEdit(source)}>
                  수정
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate(source.id)}
                  disabled={remove.isPending}
                >
                  삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sources.data && sources.data.length === 0 && (
        <output className="notice">등록된 외부 소스가 없습니다.</output>
      )}

      <form className="mt-3" onSubmit={handleSubmit}>
        <h3>{editingId ? "소스 수정" : "새 소스 등록"}</h3>

        {errorMessage && (
          <p className="alert" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="field-row">
          <div className="field">
            <label htmlFor="source-name">이름</label>
            <input
              id="source-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="예: 데일리샷"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="source-base-url">사이트 주소</label>
            <input
              id="source-base-url"
              value={form.baseUrl}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              placeholder="https://example.com"
              required
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="source-category">적용 주종</label>
            <select
              id="source-category"
              value={form.categoryId}
              onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
            >
              <option value="">전체 주종</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {formatCategoryPath(category.path)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="source-priority">우선순위 (낮을수록 먼저)</label>
            <input
              id="source-priority"
              type="number"
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: event.target.value })}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="source-rate-limit">분당 요청 한도</label>
            <input
              id="source-rate-limit"
              type="number"
              min={1}
              max={60}
              value={form.rateLimitPerMin}
              onChange={(event) => setForm({ ...form, rateLimitPerMin: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="source-ttl">캐시 유지 시간(시간)</label>
            <input
              id="source-ttl"
              type="number"
              min={1}
              value={form.ttlHours}
              onChange={(event) => setForm({ ...form, ttlHours: event.target.value })}
            />
          </div>
        </div>

        <div className="field checkbox-field">
          <label htmlFor="source-active">
            <input
              id="source-active"
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
            />
            활성 (조회 대상에 포함)
          </label>
        </div>

        <div className="field">
          <label htmlFor="source-note">메모</label>
          <input
            id="source-note"
            value={form.note}
            onChange={(event) => setForm({ ...form, note: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="source-adapter-spec">
            adapter_spec (JSON) —{" "}
            <a
              href="https://github.com/jihoon22-lee/SoolJang/blob/main/docs/architecture.md#72-두-가지-전략"
              target="_blank"
              rel="noreferrer"
            >
              스키마 문서
            </a>
          </label>
          <textarea
            id="source-adapter-spec"
            className="code-textarea"
            rows={14}
            value={form.adapterSpecText}
            onChange={(event) => setForm({ ...form, adapterSpecText: event.target.value })}
            spellCheck={false}
            required
          />
        </div>

        <div className="button-row">
          <button type="submit" className="primary" disabled={isSaving}>
            {isSaving ? "저장 중…" : editingId ? "저장" : "등록"}
          </button>
          {editingId && (
            <button type="button" onClick={startCreate}>
              취소
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
