import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { authApi, connectionsApi } from "@/api/client";
import type { ConnectionUpdate, ProviderConnection, ProviderDefinition } from "@/api/types";
import { SourcesPage } from "@/pages/SourcesPage";
import { sourceOutcomeLabel } from "@/sourceOutcome";

const REGISTRATION_LABELS: Record<ProviderConnection["registration"], string> = {
  unregistered: "미등록",
  incomplete: "일부 항목 누락",
  saved: "저장됨",
  not_required: "키 불필요",
  recovery_required: "복구 키 확인 필요",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "처리하지 못했습니다. 다시 시도하세요.";
}

/** 키는 폼의 메모리에만 머문다. 목록 진입으로 외부 연결을 자동 검사하지 않는다. */
export function ConnectionsPanel() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["auth", "me"], queryFn: ({ signal }) => authApi.me(signal) });
  const userId = me.data?.id;
  const listKey = ["connections", userId] as const;
  const definitions = useQuery({
    queryKey: ["connection-providers"],
    queryFn: ({ signal }) => connectionsApi.providers(signal),
  });
  const connections = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => connectionsApi.list(signal),
    enabled: Boolean(userId),
    gcTime: 0,
  });
  const [adding, setAdding] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: listKey });
    await client.invalidateQueries({ queryKey: ["external-sources"] });
    await client.invalidateQueries({ queryKey: ["llm-settings"] });
  };
  return (
    <section aria-labelledby="connections-heading" className="field">
      <h3 id="connections-heading">API·외부 연결</h3>
      <p className="muted">
        검색·외부 자료·라벨 인식의 연결을 한곳에서 관리합니다. 저장, 연결 확인, 사용 여부는 각각
        선택합니다.
      </p>
      <p className="muted text-sm">
        API 키는 서버에 암호화해 보관합니다. ChatGPT의 연결이나 구독이 이 앱의 API 키를 대신하지
        않습니다.
      </p>
      {(definitions.isPending || connections.isPending) && (
        <output>연결 목록을 불러오는 중…</output>
      )}
      {(definitions.isError || connections.isError) && (
        <p className="alert" role="alert">
          {errorText(definitions.error ?? connections.error)}
        </p>
      )}
      {connections.data?.map((connection) => {
        const definition = definitions.data?.find(
          (provider) => provider.kind === connection.provider_kind,
        );
        return definition ? (
          <ConnectionCard
            key={`${userId}:${connection.id}`}
            connection={connection}
            definition={definition}
            onChanged={refresh}
          />
        ) : null;
      })}
      {connections.data?.length === 0 && (
        <p className="notice">
          등록된 연결이 없습니다. 필요한 제공자부터 추가하세요. 키 없이 사용하는 소스도 있습니다.
        </p>
      )}
      <h4>연결 추가</h4>
      <p className="muted text-sm">같은 제공자의 다른 계정은 별도 이름으로 보존할 수 있습니다.</p>
      <div className="button-row">
        {definitions.data
          ?.filter((provider) => provider.kind !== "source")
          .map((provider) => (
            <button type="button" key={provider.kind} onClick={() => setAdding(provider.kind)}>
              {provider.label} 추가
            </button>
          ))}
      </div>
      {definitions.data?.map((definition) =>
        adding === definition.kind ? (
          <NewConnection
            key={definition.kind}
            definition={definition}
            onCancel={() => setAdding(null)}
            onCreated={async () => {
              setAdding(null);
              await refresh();
            }}
          />
        ) : null,
      )}
      <details className="mt-3" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>고급: 소스별 자료 수집 규칙</summary>
        <p className="muted text-sm">
          직접 등록한 소스의 주소와 파싱 규칙을 관리합니다. 인증 정보는 위 연결 카드에서 변경하세요.
        </p>
        {advancedOpen && <SourcesPage connectionsManaged />}
      </details>
    </section>
  );
}

function NewConnection({
  definition,
  onCancel,
  onCreated,
}: {
  definition: ProviderDefinition;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState(definition.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      connectionsApi.create({ provider_kind: definition.kind, name, credentials: values }),
    gcTime: 0,
    onSuccess: async () => {
      setValues({});
      await onCreated();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <form onSubmit={submit} className="panel mt-2" aria-label={`${definition.label} 연결 추가`}>
      <h4>{definition.label} 연결 추가</h4>
      <p>{definition.note}</p>
      <a href={definition.guide_url} target="_blank" rel="noopener noreferrer">
        제공자 설정 안내 열기
      </a>
      <div className="field">
        <label htmlFor="new-connection-name">연결 이름</label>
        <input
          id="new-connection-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={200}
        />
      </div>
      {definition.fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={`new-connection-${field.name}`}>{field.label}</label>
          <input
            id={`new-connection-${field.name}`}
            type="password"
            autoComplete="off"
            maxLength={4000}
            value={values[field.name] ?? ""}
            onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
          />
        </div>
      ))}
      {!definition.fields.length && <p>이 연결은 API 키가 필요하지 않습니다.</p>}
      <p className="muted text-sm">
        일부 항목은 나중에 입력해도 됩니다. 새 연결은 일시 중지 상태로 저장되며 자동 요청은 하지
        않습니다.
      </p>
      {save.isError && (
        <p className="alert" role="alert">
          {errorText(save.error)}
        </p>
      )}
      <div className="button-row">
        <button className="primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "저장 중…" : "연결 저장"}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function ConnectionCard({
  connection,
  definition,
  onChanged,
}: {
  connection: ProviderConnection;
  definition: ProviderDefinition;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [probeNotice, setProbeNotice] = useState(false);
  const toggle = useMutation({
    mutationFn: () =>
      connectionsApi.update(connection.id, {
        expected_revision: connection.config_revision,
        is_active: !connection.is_active,
      }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => connectionsApi.remove(connection.id, connection.config_revision),
    onSuccess: onChanged,
  });
  const probe = useMutation({
    mutationFn: () => connectionsApi.probe(connection.id, connection.config_revision),
    onSuccess: async (result) => {
      setMessage(
        result.applied
          ? `이번 확인: ${sourceOutcomeLabel(result.outcome)}`
          : "설정이 바뀌어 이전 검사 결과를 적용하지 않았습니다.",
      );
      await onChanged();
    },
  });
  const verification =
    connection.verified_revision === null
      ? "미검증"
      : connection.verification_stale
        ? "설정 변경 후 다시 확인 필요"
        : sourceOutcomeLabel(connection.last_outcome);
  return (
    <article className="panel mt-2" aria-label={`${connection.name} 연결`}>
      <h4>{connection.name}</h4>
      <p className="muted">
        {definition.label} ·{" "}
        {connection.origin_kind === "manual" ? "직접 등록" : "기존 설정에서 보존"}
      </p>
      <dl className="external-info-fields">
        <dt>등록</dt>
        <dd>{REGISTRATION_LABELS[connection.registration]}</dd>
        <dt>연결 확인</dt>
        <dd>{verification}</dd>
        <dt>사용</dt>
        <dd>{connection.is_active ? "사용 중" : "일시 중지"}</dd>
      </dl>
      <p className="muted text-sm">사용 기능: {connection.features.join(" · ")}</p>
      {connection.sources.length > 0 && (
        <p className="muted text-sm">
          참조 소스:{" "}
          {connection.sources
            .map((source) => `${source.name}${source.is_active ? "" : " (소스 중지)"}`)
            .join(" · ")}
        </p>
      )}
      {connection.credential_fields
        .filter((field) => field.saved)
        .map((field) => (
          <p className="text-sm" key={field.name}>
            {field.label}: {field.masked_hint}
          </p>
        ))}
      <p className="muted text-sm">
        앱 요청 예약: 이번 분 {connection.usage.minute} / {connection.rate_limit_per_min}회 ·
        오늘(UTC) {connection.usage.day} / {connection.request_limit_per_day}회
      </p>
      <p className="muted text-sm">
        제공자 잔액·남은 할당량: 확인되지 않음. 앱 예약 수는 제공자 청구량과 다를 수 있습니다.
      </p>
      <p className="muted text-sm">
        저장 {new Date(connection.updated_at).toLocaleString("ko-KR")}
        {connection.last_test_at &&
          ` · 최근 확인 ${new Date(connection.last_test_at).toLocaleString("ko-KR")}`}
      </p>
      {connection.provider_kind === "openai_ocr" && (
        <p className="text-sm">
          라벨 인식 모델: {connection.ocr_model} · AI 매칭 보조{" "}
          {connection.ocr_rematch_enabled ? "켜짐" : "꺼짐"}
        </p>
      )}
      {message && <output>{message}</output>}
      {(toggle.isError || remove.isError || probe.isError) && (
        <p role="alert" className="alert">
          {errorText(toggle.error ?? remove.error ?? probe.error)}
        </p>
      )}
      <div className="button-row">
        <button type="button" onClick={() => setEditing((value) => !value)}>
          {editing ? "설정 닫기" : "설정 변경"}
        </button>
        <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {connection.is_active ? "사용 일시 중지" : "사용 시작"}
        </button>
        <button
          type="button"
          disabled={probe.isPending}
          onClick={() => setProbeNotice((value) => !value)}
        >
          {probe.isPending ? "확인 중…" : "연결 확인"}
        </button>
        <button type="button" onClick={() => setRemoving(true)}>
          연결 해제
        </button>
      </div>
      {probeNotice && (
        <div className="notice mt-1">
          <p>{definition.note}</p>
          <p>
            확인 버튼을 누르면 제한된 외부 요청을 보냅니다. 사용량이나 요금에 반영될 수 있으며
            저장·활성 상태는 바꾸지 않습니다.
          </p>
          <button
            type="button"
            onClick={() => {
              setProbeNotice(false);
              setMessage(null);
              probe.mutate();
            }}
            disabled={probe.isPending}
          >
            지금 연결 확인
          </button>
        </div>
      )}
      {editing && (
        <ConnectionEditor
          key={`${connection.id}:${connection.config_revision}`}
          connection={connection}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      )}
      {removing && (
        <div className="alert mt-1" role="alert">
          <p>
            이 연결의 인증 정보를 삭제하고 {connection.features.join(" · ")} 사용을 중지합니다.
            연결된 소스와 사용자 고정·구매 기록은 보존합니다.
          </p>
          <p>
            이미 전송된 요청은 끝날 수 있습니다. 설정 변경 뒤 늦게 도착한 결과는 새 설정에 적용하지
            않습니다.
          </p>
          <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
            인증 정보 삭제하고 해제
          </button>
          <button type="button" onClick={() => setRemoving(false)}>
            취소
          </button>
        </div>
      )}
    </article>
  );
}

function ConnectionEditor({
  connection,
  onSaved,
}: {
  connection: ProviderConnection;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(connection.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<string[]>([]);
  const [perMinute, setPerMinute] = useState(connection.rate_limit_per_min);
  const [perDay, setPerDay] = useState(connection.request_limit_per_day);
  const [model, setModel] = useState(connection.ocr_model);
  const [rematch, setRematch] = useState(connection.ocr_rematch_enabled);
  const [rematchCap, setRematchCap] = useState(connection.ocr_rematch_monthly_cap);
  const save = useMutation({
    mutationFn: () => {
      const input: ConnectionUpdate = {
        expected_revision: connection.config_revision,
        name,
        rate_limit_per_min: perMinute,
        request_limit_per_day: perDay,
        credentials: Object.fromEntries(
          Object.entries(values).filter(([field]) => !deleted.includes(field)),
        ),
        delete_credentials: deleted,
      };
      if (connection.provider_kind === "openai_ocr")
        Object.assign(input, {
          ocr_model: model,
          ocr_rematch_enabled: rematch,
          ocr_rematch_monthly_cap: rematchCap,
        });
      return connectionsApi.update(connection.id, input);
    },
    gcTime: 0,
    onSuccess: async () => {
      setValues({});
      await onSaved();
    },
  });
  return (
    <form
      aria-label={`${connection.name} 설정 변경`}
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="notice text-sm">
        빈 키 입력은 기존 값을 유지합니다. 삭제할 항목은 따로 선택하세요. 변경은 참조 중인 모든
        기능·소스에 적용되며 진행 중인 확인 결과는 이전 설정의 결과가 됩니다.
      </p>
      <div className="field">
        <label htmlFor={`conn-name-${connection.id}`}>연결 이름</label>
        <input
          id={`conn-name-${connection.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      {connection.credential_fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={`conn-${connection.id}-${field.name}`}>{field.label}</label>
          <input
            id={`conn-${connection.id}-${field.name}`}
            type="password"
            autoComplete="off"
            maxLength={4000}
            value={values[field.name] ?? ""}
            disabled={deleted.includes(field.name)}
            placeholder={field.saved ? "비워 두면 기존 값 유지" : "등록할 값을 입력하세요"}
            onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
          />
          {field.saved && (
            <label>
              <input
                type="checkbox"
                checked={deleted.includes(field.name)}
                onChange={(event) =>
                  setDeleted(
                    event.target.checked
                      ? [...deleted, field.name]
                      : deleted.filter((name) => name !== field.name),
                  )
                }
              />{" "}
              {field.label} 삭제
            </label>
          )}
        </div>
      ))}
      <div className="field-row">
        <div className="field">
          <label htmlFor={`conn-minute-${connection.id}`}>분당 요청 상한</label>
          <input
            id={`conn-minute-${connection.id}`}
            type="number"
            min={1}
            max={60}
            value={perMinute}
            onChange={(event) => setPerMinute(Number(event.target.value))}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`conn-day-${connection.id}`}>하루 요청 상한</label>
          <input
            id={`conn-day-${connection.id}`}
            type="number"
            min={1}
            max={100000}
            value={perDay}
            onChange={(event) => setPerDay(Number(event.target.value))}
            required
          />
        </div>
      </div>
      {connection.provider_kind === "openai_ocr" && (
        <>
          <div className="field">
            <label htmlFor={`conn-model-${connection.id}`}>라벨 인식 모델</label>
            <input
              id={`conn-model-${connection.id}`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
            />
          </div>
          <label>
            <input
              type="checkbox"
              checked={rematch}
              onChange={(event) => setRematch(event.target.checked)}
            />{" "}
            AI 매칭 보조 사용
          </label>
          <p className="muted text-sm">
            기존 선택형 기능입니다. 켜도 자동으로 제품을 고정하지 않으며 새 다중 출처 검색에는
            사용하지 않습니다.
          </p>
          {rematch && (
            <div className="field">
              <label htmlFor={`conn-rematch-${connection.id}`}>AI 매칭 월 호출 상한</label>
              <input
                id={`conn-rematch-${connection.id}`}
                type="number"
                min={1}
                max={100000}
                value={rematchCap}
                onChange={(event) => setRematchCap(Number(event.target.value))}
                required
              />
            </div>
          )}
        </>
      )}
      {save.isError && (
        <p className="alert" role="alert">
          {errorText(save.error)}
        </p>
      )}
      <button type="submit" className="primary" disabled={save.isPending}>
        {save.isPending ? "저장 중…" : "변경 저장"}
      </button>
    </form>
  );
}
