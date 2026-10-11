import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { type Interest, type InterestIdentity, interestsApi } from "@/api/interests";
import { publicLink } from "@/discovery/useDiscovery";
import { databaseIdentity } from "@/sync/db";
import { captureFormDraft, clearSubmittedDraft, useDraftState } from "@/sync/drafts";

function initial(interest?: Interest) {
  return {
    identity: interest?.identity ?? ({ name: "" } as InterestIdentity),
    name: interest?.name ?? "",
    nameEn: interest?.identity.name_en ?? "",
    aliases: interest?.identity.search_aliases?.join("\n") ?? "",
    producer: interest?.identity.producer ?? "",
    volumes: interest?.identity.volumes_ml?.join(", ") ?? "",
    abv: interest?.identity.abv ?? "",
    vintage: String(interest?.identity.vintage ?? ""),
    age: interest?.identity.age_years ?? "",
    note: interest?.note ?? "",
    matches: interest?.source_matches ?? {},
    references: interest?.reference_urls?.join("\n") ?? "",
    revision: interest?.updated_at ?? "",
    requestId: "",
  };
}

export function InterestEditor({
  interest,
  disabled,
  onChanged,
  onClose,
}: {
  interest?: Interest;
  disabled: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const formKey = `interest-editor:${interest?.id ?? "new"}`;
  const [draft, setDraft] = useDraftState(formKey, initial(interest));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = useMutation({
    networkMode: "always",
    mutationFn: async (requestId: string) => {
      if (disabled) throw new Error("온라인에서 관심 정보를 저장하세요");
      const owner = databaseIdentity();
      const snapshot = captureFormDraft(formKey);
      const volumes = draft.volumes
        .split(/[,/\s]+/)
        .filter(Boolean)
        .map(Number);
      if (volumes.some((value) => !Number.isInteger(value) || value <= 0 || value > 100000))
        throw new Error("용량은 1~100000 ml의 정수로 입력하세요");
      const identity: InterestIdentity = {
        ...draft.identity,
        name: draft.name.trim(),
        name_en: draft.nameEn.trim() || null,
        producer: draft.producer.trim() || null,
        search_aliases: [
          ...new Set(
            draft.aliases
              .split("\n")
              .map((text) => text.trim())
              .filter(Boolean),
          ),
        ],
        volumes_ml: [...new Set(volumes)],
        abv: draft.abv || null,
        vintage: draft.vintage ? Number(draft.vintage) : null,
        age_years: draft.age || null,
      };
      const reference_urls = draft.references
        .split("\n")
        .map((text) => text.trim())
        .filter(Boolean);
      const saved = interest
        ? await interestsApi.update(interest.id, {
            identity,
            note: draft.note || null,
            source_matches: draft.matches,
            reference_urls,
            expected_updated_at: draft.revision,
          })
        : await interestsApi.create(identity, draft.note || null, requestId, reference_urls);
      const current = databaseIdentity();
      if (owner.userId !== current.userId || owner.generation !== current.generation) return;
      clearSubmittedDraft(snapshot);
      onChanged();
      if (mounted.current) {
        setDraft(initial(interest ? saved : undefined));
        if (!interest) onClose();
      }
      return saved;
    },
    onError: () => {
      if (mounted.current) onChanged();
    },
  });
  function textField(
    key: "name" | "nameEn" | "producer" | "volumes",
    label: string,
    required = false,
  ) {
    return (
      <label>
        {label}
        <input
          required={required}
          maxLength={key === "volumes" ? 200 : 300}
          value={draft[key]}
          onChange={(event) => {
            save.reset();
            setDraft({ ...draft, [key]: event.target.value, requestId: "" });
          }}
        />
      </label>
    );
  }
  return (
    <form
      className="interest-editor card"
      aria-label={interest ? "관심 정보 수정" : "관심 제품 추가"}
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending) return;
        const requestId = draft.requestId || crypto.randomUUID();
        if (!interest && !draft.requestId)
          flushSync(() => setDraft((old) => ({ ...old, requestId })));
        save.mutate(requestId);
      }}
    >
      <h2>{interest ? "관심 정보 수정" : "관심 제품 추가"}</h2>
      <fieldset disabled={disabled || save.isPending}>
        <legend>제품 식별 정보와 메모</legend>
        {textField("name", "관심 제품 이름", true)}
        {textField("nameEn", "영문명·원어명")}
        {textField("producer", "생산자")}
        {textField("volumes", "용량 ml (여러 규격은 쉼표로 구분)")}
        {(
          [
            ["abv", "도수 %", 0, 100],
            ["vintage", "빈티지", 1800, 2200],
            ["age", "숙성 연수", 0, 100],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              step={key === "vintage" ? 1 : "any"}
              value={draft[key]}
              onChange={(event) => {
                save.reset();
                setDraft({ ...draft, [key]: event.target.value, requestId: "" });
              }}
            />
          </label>
        ))}
        <label>
          확인한 검색 별칭 (한 줄에 하나)
          <textarea
            maxLength={9000}
            value={draft.aliases}
            onChange={(event) => setDraft({ ...draft, aliases: event.target.value, requestId: "" })}
          />
        </label>
        <label className="interest-wide">
          관심 노트
          <textarea
            maxLength={5000}
            value={draft.note}
            onChange={(event) => setDraft({ ...draft, note: event.target.value, requestId: "" })}
          />
        </label>
        <label className="interest-wide">
          참고 출처 URL (한 줄에 하나)
          <textarea
            maxLength={40000}
            value={draft.references}
            onChange={(event) =>
              setDraft({ ...draft, references: event.target.value, requestId: "" })
            }
          />
        </label>
        {Object.entries(draft.matches).map(([id, match]) => (
          <div key={id} className="interest-wide">
            <span>{match.external_name}</span>{" "}
            {publicLink(match.external_url) && (
              <a href={publicLink(match.external_url)} target="_blank" rel="noreferrer">
                고정 출처
              </a>
            )}{" "}
            <button
              type="button"
              onClick={() =>
                setDraft((old) => ({
                  ...old,
                  matches: Object.fromEntries(
                    Object.entries(old.matches).filter(([key]) => key !== id),
                  ),
                }))
              }
            >
              고정 해제
            </button>
          </div>
        ))}
        {interest && (
          <p className="interest-wide muted">
            식별 정보를 바꾸면 이전 출처 고정을 해제하고 가격 감시를 중지합니다. 기존 관측·구매
            기록은 유지합니다.
          </p>
        )}
        <div className="button-row interest-wide">
          <button className="primary" type="submit">
            {save.isPending ? "저장 중…" : interest ? "변경 저장" : "관심 저장"}
          </button>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </fieldset>
      {save.error && <p role="alert">{save.error.message}</p>}
      {save.isSuccess && <output>관심 정보를 저장했습니다.</output>}
      {interest && draft.revision !== interest.updated_at && (
        <div className="interest-wide">
          <p>다른 화면에서 이 관심이 변경되었습니다. 내 입력을 확인한 뒤 최신 기록을 불러오세요.</p>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => {
              setDraft(initial(interest));
              save.reset();
            }}
          >
            최신 관심 정보 불러오기
          </button>
        </div>
      )}
    </form>
  );
}
