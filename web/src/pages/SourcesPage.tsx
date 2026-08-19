import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, Fragment, useState } from "react";

import { ApiError, externalSourcesApi } from "@/api/client";
import type { ExternalSource, ExternalSourceInput, SourceHealth, SourcePreset } from "@/api/types";
import { formatCategoryPath } from "@/format";
import { getCategoryTree } from "@/sync/queries";

//: 헬스 상태별 화면 표시 문구(Task 34 PR4).
const HEALTH_LABELS: Record<SourceHealth["status"], string> = {
  healthy: "정상",
  degraded: "부분 실패",
  failing: "실패",
  unknown: "미확인",
};

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
  const health = useQuery({
    queryKey: ["external-sources-health"],
    queryFn: ({ signal }) => externalSourcesApi.health(signal),
  });
  const healthBySourceId = new Map((health.data ?? []).map((entry) => [entry.source_id, entry]));

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
            <SourceRow
              key={source.id}
              source={source}
              health={healthBySourceId.get(source.id)}
              categoryPath={
                source.category_id
                  ? formatCategoryPath(
                      categories.find((c) => c.id === source.category_id)?.path ?? [],
                    )
                  : "전체 주종"
              }
              onEdit={() => startEdit(source)}
              onRemove={() => remove.mutate(source.id)}
              removing={remove.isPending}
            />
          ))}
        </ul>
      )}

      {sources.data && sources.data.length === 0 && (
        <output className="notice">등록된 외부 소스가 없습니다.</output>
      )}

      <PresetCatalog onCreated={invalidate} />

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

/**
 * 프리셋 카탈로그 — 검증된 스펙을 이름 하나로 골라 등록한다(Task 34 PR5).
 *
 * `adapter_spec` JSON 을 직접 쓰지 않아도 되는 것이 프리셋의 요점이다. 자격 증명이
 * 필요한 프리셋은 "추가" 를 눌러도 바로 등록하지 않고 입력 폼을 먼저 연다 — 값 없이
 * 등록하면 조회가 인증 없이 나가 사이트가 거부할 뿐이라, 처음부터 받는 편이 낫다.
 */
function PresetCatalog({ onCreated }: { onCreated: () => void }) {
  const presets = useQuery({
    queryKey: ["external-source-presets"],
    queryFn: ({ signal }) => externalSourcesApi.presets(signal),
  });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [credentialName, setCredentialName] = useState("");
  const [credentialValue, setCredentialValue] = useState("");

  const createFromPreset = useMutation({
    mutationFn: async (input: {
      presetKey: string;
      credential: { name: string; value: string } | null;
    }) => {
      const source = await externalSourcesApi.create({ preset_key: input.presetKey });
      if (input.credential?.name && input.credential.value) {
        await externalSourcesApi.setCredentials(source.id, {
          values: { [input.credential.name]: input.credential.value },
        });
      }
      return source;
    },
    onSuccess: () => {
      setOpenKey(null);
      setCredentialName("");
      setCredentialValue("");
      onCreated();
    },
  });

  if (!presets.data || presets.data.length === 0) {
    return null;
  }

  return (
    <section className="mt-3">
      <h3>추천 소스에서 추가</h3>
      <p className="muted text-sm">
        검증된 설정으로 바로 등록합니다. 사이트 개편 시 앱 업데이트로 자동 갱신됩니다(직접 수정한
        스펙은 덮어쓰지 않습니다).
      </p>
      <ul className="vendor-list">
        {presets.data.map((preset) => (
          <PresetRow
            key={preset.key}
            preset={preset}
            formOpen={openKey === preset.key}
            onToggleForm={() =>
              setOpenKey((current) => (current === preset.key ? null : preset.key))
            }
            credentialName={credentialName}
            credentialValue={credentialValue}
            onCredentialNameChange={setCredentialName}
            onCredentialValueChange={setCredentialValue}
            onAddPlain={() => createFromPreset.mutate({ presetKey: preset.key, credential: null })}
            onAddWithCredential={() =>
              createFromPreset.mutate({
                presetKey: preset.key,
                credential: { name: credentialName.trim(), value: credentialValue },
              })
            }
            adding={createFromPreset.isPending}
          />
        ))}
      </ul>
      {createFromPreset.isError && (
        <p className="alert" role="alert">
          추가에 실패했습니다:{" "}
          {createFromPreset.error instanceof Error
            ? createFromPreset.error.message
            : "알 수 없는 오류"}
        </p>
      )}
    </section>
  );
}

function PresetRow({
  preset,
  formOpen,
  onToggleForm,
  credentialName,
  credentialValue,
  onCredentialNameChange,
  onCredentialValueChange,
  onAddPlain,
  onAddWithCredential,
  adding,
}: {
  preset: SourcePreset;
  formOpen: boolean;
  onToggleForm: () => void;
  credentialName: string;
  credentialValue: string;
  onCredentialNameChange: (value: string) => void;
  onCredentialValueChange: (value: string) => void;
  onAddPlain: () => void;
  onAddWithCredential: () => void;
  adding: boolean;
}) {
  return (
    <li className="vendor-row">
      <span className="name">{preset.name}</span>
      <span className="muted">{preset.base_url}</span>
      <span className="muted text-sm">{preset.description}</span>

      {preset.requires_credentials ? (
        <div className="button-row">
          <button type="button" onClick={onToggleForm}>
            {formOpen ? "닫기" : "추가(자격 증명 필요)"}
          </button>
        </div>
      ) : (
        <div className="button-row">
          <button type="button" onClick={onAddPlain} disabled={adding}>
            추가
          </button>
        </div>
      )}

      {formOpen && (
        <div className="field-row">
          <div className="field">
            <label htmlFor={`preset-cred-name-${preset.key}`}>자격 증명 이름</label>
            <input
              id={`preset-cred-name-${preset.key}`}
              value={credentialName}
              onChange={(event) => onCredentialNameChange(event.target.value)}
              placeholder="예: client_id"
            />
          </div>
          <div className="field">
            <label htmlFor={`preset-cred-value-${preset.key}`}>값</label>
            <input
              id={`preset-cred-value-${preset.key}`}
              type="password"
              value={credentialValue}
              onChange={(event) => onCredentialValueChange(event.target.value)}
            />
          </div>
          <button type="button" onClick={onAddWithCredential} disabled={adding}>
            등록
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * 소스 한 행 — 등록 정보에 더해 헬스 배지와 "테스트 조회" 를 붙인다(Task 34 PR4).
 *
 * 실제 소유한 제품이 없어도 샘플 이름으로 소스가 지금 살아 있는지 바로 확인할 수 있게
 * 한다. 결과는 캐시에 저장되지 않고 헬스 로그에만 남는다(`POST .../probe`).
 */
function SourceRow({
  source,
  health,
  categoryPath,
  onEdit,
  onRemove,
  removing,
}: {
  source: ExternalSource;
  health: SourceHealth | undefined;
  categoryPath: string;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const queryClient = useQueryClient();
  const [probeOpen, setProbeOpen] = useState(false);
  const [sampleName, setSampleName] = useState(source.name);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [credentialName, setCredentialName] = useState("");
  const [credentialValue, setCredentialValue] = useState("");

  const invalidateSources = () =>
    void queryClient.invalidateQueries({ queryKey: ["external-sources"] });

  const probe = useMutation({
    mutationFn: () => externalSourcesApi.probe(source.id, { name: sampleName.trim() }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["external-sources-health"] }),
  });

  const saveCredential = useMutation({
    mutationFn: () =>
      externalSourcesApi.setCredentials(source.id, {
        values: { [credentialName.trim()]: credentialValue },
      }),
    onSuccess: () => {
      setCredentialName("");
      setCredentialValue("");
      invalidateSources();
    },
  });

  const status = health?.status ?? "unknown";
  const credentialEntries = Object.entries(source.credential_hints);

  return (
    <li className="vendor-row">
      <span className="name">{source.name}</span>
      <span className="muted">{source.base_url}</span>
      <span className="muted">{source.is_active ? "활성" : "비활성"}</span>
      <span className="muted">우선순위 {source.priority}</span>
      <span className="muted">{categoryPath}</span>
      <span className="badge">{HEALTH_LABELS[status]}</span>
      {health?.last_warning && <span className="muted text-sm">{health.last_warning}</span>}
      {source.preset_key && (
        <span className="muted text-sm">
          프리셋: {source.preset_key}
          {source.spec_overridden && " (직접 수정됨)"}
        </span>
      )}

      <div className="button-row">
        <button type="button" onClick={onEdit}>
          수정
        </button>
        <button type="button" onClick={onRemove} disabled={removing}>
          삭제
        </button>
        <button type="button" onClick={() => setProbeOpen((open) => !open)}>
          {probeOpen ? "테스트 조회 닫기" : "테스트 조회"}
        </button>
        <button type="button" onClick={() => setCredentialsOpen((open) => !open)}>
          {credentialsOpen ? "자격 증명 닫기" : "자격 증명"}
        </button>
      </div>

      {probeOpen && (
        <div className="field-row">
          <div className="field">
            <label htmlFor={`probe-name-${source.id}`}>샘플 제품명</label>
            <input
              id={`probe-name-${source.id}`}
              value={sampleName}
              onChange={(event) => setSampleName(event.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => probe.mutate()}
            disabled={probe.isPending || !sampleName.trim()}
          >
            {probe.isPending ? "조회 중…" : "실행"}
          </button>
        </div>
      )}

      {probe.isSuccess && (
        <output className="notice text-sm">
          {probe.data.ok ? `성공 — 매칭: ${probe.data.matched_name ?? "확인 안 됨"}` : "실패"}
          {probe.data.warning && ` (${probe.data.warning})`}
        </output>
      )}
      {probe.isError && (
        <p className="alert" role="alert">
          테스트 조회에 실패했습니다:{" "}
          {probe.error instanceof Error ? probe.error.message : "알 수 없는 오류"}
        </p>
      )}

      {credentialsOpen && (
        <div className="mt-1">
          {credentialEntries.length > 0 && (
            <dl className="external-info-fields">
              {credentialEntries.map(([name, hint]) => (
                <Fragment key={name}>
                  <dt className="muted">{name}</dt>
                  <dd>...{hint}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          <div className="field-row">
            <div className="field">
              <label htmlFor={`cred-name-${source.id}`}>이름</label>
              <input
                id={`cred-name-${source.id}`}
                value={credentialName}
                onChange={(event) => setCredentialName(event.target.value)}
                placeholder="예: client_id"
              />
            </div>
            <div className="field">
              <label htmlFor={`cred-value-${source.id}`}>값</label>
              <input
                id={`cred-value-${source.id}`}
                type="password"
                value={credentialValue}
                onChange={(event) => setCredentialValue(event.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => saveCredential.mutate()}
              disabled={saveCredential.isPending || !credentialName.trim() || !credentialValue}
            >
              저장
            </button>
          </div>
          {saveCredential.isError && (
            <p className="alert" role="alert">
              저장에 실패했습니다:{" "}
              {saveCredential.error instanceof Error
                ? saveCredential.error.message
                : "알 수 없는 오류"}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
