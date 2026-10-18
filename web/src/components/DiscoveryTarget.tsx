import type { InterestIdentity, InterestSourceMatch } from "@/api/interests";
import { publicLink } from "@/discovery/useDiscovery";

export interface DiscoverySelection {
  identity: InterestIdentity;
  references: string[];
  confirmed: boolean;
  matches?: Record<string, InterestSourceMatch>;
  /** 제품명·규격을 정한 출처. 같은 출처에서 후보를 바꾸면 식별값도 새 후보로 바꾼다. */
  identitySource?: string;
}
export function DiscoveryTarget({
  target,
  locked,
  disabled,
  onChange,
  onClear,
}: {
  target: DiscoverySelection;
  locked: boolean;
  disabled: boolean;
  onChange: (target: DiscoverySelection) => void;
  onClear: () => void;
}) {
  const change = (identity: InterestIdentity) =>
    onChange({ ...target, identity, confirmed: false });
  return (
    <section className="discovery-target" aria-label="관심 저장 대상 확인">
      <h2>관심으로 남길 제품</h2>
      <p className="muted">
        제목과 검색어는 실제 제품명과 다를 수 있습니다. 제품명·판본·규격을 확인하세요. 확인하지 못한
        값은 비워 둡니다.
      </p>
      <fieldset disabled={disabled}>
        <div className="field-grid">
          <label>
            저장할 제품명
            <input
              required
              maxLength={300}
              readOnly={locked}
              value={target.identity.name}
              onChange={(event) => change({ ...target.identity, name: event.target.value })}
            />
          </label>
          <label>
            저장할 원어명
            <input
              maxLength={300}
              readOnly={locked}
              value={target.identity.name_en ?? ""}
              onChange={(event) =>
                change({ ...target.identity, name_en: event.target.value || null })
              }
            />
          </label>
          <label>
            저장할 생산자
            <input
              maxLength={300}
              readOnly={locked}
              value={target.identity.producer ?? ""}
              onChange={(event) =>
                change({ ...target.identity, producer: event.target.value || null })
              }
            />
          </label>
          {(
            [
              ["abv", "저장할 도수", 0, 100],
              ["vintage", "저장할 빈티지", 1800, 2200],
              ["age_years", "저장할 숙성 연수", 0, 100],
            ] as const
          ).map(([field, label, min, max]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                inputMode={field === "vintage" ? "numeric" : "decimal"}
                min={min}
                max={max}
                step={field === "vintage" ? 1 : "any"}
                readOnly={locked}
                value={target.identity[field] ?? ""}
                onChange={(event) =>
                  change({
                    ...target.identity,
                    [field]: event.target.value
                      ? field === "vintage"
                        ? Number(event.target.value)
                        : event.target.value
                      : null,
                  })
                }
              />
            </label>
          ))}
          <label>
            저장할 용량 ml
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={100000}
              step={1}
              readOnly={locked}
              value={target.identity.volumes_ml?.[0] ?? ""}
              onChange={(event) =>
                change({
                  ...target.identity,
                  volumes_ml: event.target.value ? [Number(event.target.value)] : [],
                })
              }
            />
          </label>
        </div>
        {locked && (target.identity.volumes_ml?.length ?? 0) > 1 && (
          <p>등록 규격: {target.identity.volumes_ml?.join(" / ")} ml</p>
        )}
        <p>참고 출처 {target.references.length}개</p>
        {target.references.map(
          (url) =>
            publicLink(url) && (
              <p key={url}>
                <a href={publicLink(url)} target="_blank" rel="noreferrer">
                  {new URL(url).hostname} · 선택 출처
                </a>
              </p>
            ),
        )}
        <label className="discovery-choice">
          <input
            type="checkbox"
            checked={target.confirmed}
            onChange={(event) => onChange({ ...target, confirmed: event.target.checked })}
          />
          제품명·판본·규격과 선택 출처를 확인했습니다
        </label>
        <button type="button" onClick={onClear}>
          자료 선택 해제
        </button>
      </fieldset>
    </section>
  );
}
