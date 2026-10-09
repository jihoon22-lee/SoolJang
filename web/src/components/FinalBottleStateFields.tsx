import { useId } from "react";
import type { BottleSnapshot, BottleStatus, FinalBottleState } from "@/api/types";
import { STATUS_LABELS } from "@/components/BottlePanel";
import { todayLocal } from "@/format";

export function finalStateOf(bottle: BottleSnapshot): FinalBottleState {
  return {
    id: bottle.id,
    status: bottle.status,
    remaining_ml: bottle.remaining_ml,
    opened_on: bottle.opened_on,
    finished_on: bottle.finished_on,
  };
}

export function FinalBottleStateFields({
  current,
  value,
  volumeMl,
  contextLabel,
  disabled,
  onChange,
}: {
  current: BottleSnapshot;
  value: FinalBottleState;
  volumeMl: number;
  contextLabel: string;
  disabled?: boolean;
  onChange: (next: FinalBottleState) => void;
}) {
  const id = useId();
  return (
    <fieldset className="correction-bottle" disabled={disabled}>
      <legend>{contextLabel}</legend>
      <p className="muted text-sm">
        현재 {STATUS_LABELS[current.status]} ·{" "}
        {current.remaining_ml === null
          ? current.status === "unopened"
            ? "미개봉 전량"
            : "잔량 미기록"
          : `${current.remaining_ml}ml`}
        {current.deleted_at ? " · 삭제된 병의 보존 기록" : ""}
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-status`}>적용할 최종 상태</label>
          <select
            id={`${id}-status`}
            value={value.status}
            onChange={(event) => onChange({ ...value, status: event.target.value as BottleStatus })}
          >
            {Object.entries(STATUS_LABELS).map(([status, label]) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-remaining`}>적용할 최종 잔량 (ml)</label>
          <input
            id={`${id}-remaining`}
            type="number"
            min={0}
            max={volumeMl}
            step={1}
            inputMode="numeric"
            value={value.remaining_ml ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                remaining_ml: event.target.value === "" ? null : Number(event.target.value),
              })
            }
          />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`${id}-opened`}>적용할 개봉일</label>
          <input
            id={`${id}-opened`}
            type="date"
            max={todayLocal()}
            value={value.opened_on ?? ""}
            onChange={(event) => onChange({ ...value, opened_on: event.target.value || null })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-finished`}>적용할 소진·처분일</label>
          <input
            id={`${id}-finished`}
            type="date"
            max={todayLocal()}
            value={value.finished_on ?? ""}
            onChange={(event) => onChange({ ...value, finished_on: event.target.value || null })}
          />
        </div>
      </div>
      <p className="muted text-sm">
        {value.status === "unopened"
          ? `미개봉은 잔량·날짜를 비우면 ${volumeMl}ml 전량입니다.`
          : value.status === "finished"
            ? "소진은 잔량 0ml로 입력하세요. 알고 있는 개봉일·소진일을 함께 남길 수 있습니다."
            : "잔량을 비우면 미기록으로 보존합니다. 날짜와 잔량은 입력한 최종값으로 적용합니다."}
      </p>
    </fieldset>
  );
}
