/**
 * 시음 입력 칸. 자주 쓰는 것(날짜·평점·따른 양)을 먼저 보이고, 향·맛·피니시·장소·동석자는
 * "자세히 기록" 안에 접어 둔다. 예전 8칸 세로 나열은 한 잔 기록하기에 너무 길었다.
 */

import { useId } from "react";
import { RatingStars } from "@/components/RatingStars";
import { todayLocal } from "@/format";

export interface TastingFieldValues {
  tastedOn: string;
  pouredMl: string;
  rating: string;
  nose: string;
  palate: string;
  finish: string;
  place: string;
  companions: string;
}

/** 자주 따르는 양. 잔 크기가 제각각이라 근삿값으로 고르고, 정확하면 직접 입력한다. */
const POUR_PRESETS = [30, 50, 100, 150];

export function TastingFields({
  values,
  onChange,
  remainingMl,
}: {
  values: TastingFieldValues;
  onChange: (patch: Partial<TastingFieldValues>) => void;
  /** 남은 양을 알면 넘는 프리셋을 막고 안내한다. */
  remainingMl?: number | null | undefined;
}) {
  const ids = {
    date: useId(),
    poured: useId(),
    nose: useId(),
    palate: useId(),
    finish: useId(),
    place: useId(),
    companions: useId(),
  };
  const hasDetails = [
    values.nose,
    values.palate,
    values.finish,
    values.place,
    values.companions,
  ].some((value) => value.trim() !== "");
  return (
    <div className="tasting-fields">
      <div className="field">
        <label htmlFor={ids.date}>마신 날</label>
        <input
          id={ids.date}
          type="date"
          required
          max={todayLocal()}
          value={values.tastedOn}
          onChange={(event) => onChange({ tastedOn: event.target.value })}
        />
      </div>

      <RatingStars value={values.rating} onChange={(rating) => onChange({ rating })} />

      <fieldset className="pour-presets">
        <legend>따른 양</legend>
        <div className="button-row">
          {POUR_PRESETS.map((ml) => (
            <button
              key={ml}
              type="button"
              aria-pressed={values.pouredMl === String(ml)}
              disabled={remainingMl !== null && remainingMl !== undefined && ml > remainingMl}
              onClick={() =>
                onChange({ pouredMl: values.pouredMl === String(ml) ? "" : String(ml) })
              }
            >
              {ml}ml
            </button>
          ))}
          {/* 캔·작은 병은 한 번에 다 마시는 경우가 많다. 남은 양을 모두 따르면 소진으로 기록된다. */}
          {remainingMl && !POUR_PRESETS.includes(remainingMl) ? (
            <button
              type="button"
              aria-pressed={values.pouredMl === String(remainingMl)}
              onClick={() =>
                onChange({
                  pouredMl: values.pouredMl === String(remainingMl) ? "" : String(remainingMl),
                })
              }
            >
              남은 양 전부({remainingMl}ml)
            </button>
          ) : null}
        </div>
        {remainingMl && values.pouredMl === String(remainingMl) ? (
          <p className="muted text-sm">저장하면 이 병을 다 마신 것으로(소진) 기록합니다.</p>
        ) : null}
        <label htmlFor={ids.poured}>
          직접 입력(ml)
          {remainingMl ? <span className="muted"> · 남은 양 {remainingMl}ml</span> : null}
        </label>
        <input
          id={ids.poured}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="기억나지 않으면 비워 두세요"
          value={values.pouredMl}
          onChange={(event) => onChange({ pouredMl: event.target.value })}
        />
      </fieldset>

      <details className="tasting-details" open={hasDetails}>
        <summary>자세히 기록 (향·맛·피니시·장소·동석자)</summary>
        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.nose}>향</label>
            <input
              id={ids.nose}
              value={values.nose}
              onChange={(event) => onChange({ nose: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.palate}>맛</label>
            <input
              id={ids.palate}
              value={values.palate}
              onChange={(event) => onChange({ palate: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.finish}>피니시</label>
            <input
              id={ids.finish}
              value={values.finish}
              onChange={(event) => onChange({ finish: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.place}>장소</label>
            <input
              id={ids.place}
              value={values.place}
              onChange={(event) => onChange({ place: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.companions}>동석자</label>
            <input
              id={ids.companions}
              value={values.companions}
              onChange={(event) => onChange({ companions: event.target.value })}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
