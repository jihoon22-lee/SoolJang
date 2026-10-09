/**
 * 개봉 병 잔량 조정. 눈대중(약 3/4·절반·1/4)으로 빠르게 고르거나 ml 로 직접 입력한다.
 *
 * 시음 기록 없이 줄어든 양(요리·나눔)이나 잘못 기록된 잔량을 바로잡는다. 0 은 소진이다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { useId, useState } from "react";
import type { Bottle } from "@/api/types";
import { bottleVolumeMl } from "@/sync/bottleActions";
import { db } from "@/sync/db";

const FRACTIONS = [
  { label: "약 3/4", ratio: 0.75 },
  { label: "절반", ratio: 0.5 },
  { label: "약 1/4", ratio: 0.25 },
] as const;

export function RemainingEditor({
  bottle,
  onSet,
  pending = false,
}: {
  bottle: Bottle;
  onSet: (remainingMl: number) => void;
  pending?: boolean;
}) {
  const volume = useLiveQuery(async () => {
    const row = await db.bottle.get(bottle.id);
    return row ? bottleVolumeMl(row.purchase_id as string) : null;
  }, [bottle.id]);
  const [custom, setCustom] = useState("");
  const [open, setOpen] = useState(false);
  const inputId = useId();

  const customValue = Number(custom);
  const customValid =
    custom.trim() !== "" &&
    Number.isInteger(customValue) &&
    customValue >= 0 &&
    (volume == null || customValue <= volume);

  return (
    <div className="remaining-editor">
      <button type="button" className="sort-button" onClick={() => setOpen((value) => !value)}>
        {open ? "잔량 조정 닫기" : "잔량 조정"}
      </button>
      {open ? (
        <div className="sheet">
          <fieldset className="button-row">
            <legend className="sr-only">남은 양 고르기</legend>
            {volume
              ? FRACTIONS.map((fraction) => (
                  <button
                    key={fraction.label}
                    type="button"
                    disabled={pending}
                    onClick={() => onSet(Math.round(volume * fraction.ratio))}
                  >
                    {fraction.label} ({Math.round(volume * fraction.ratio)}ml)
                  </button>
                ))
              : null}
            <button type="button" disabled={pending} onClick={() => onSet(0)}>
              다 마심(소진)
            </button>
          </fieldset>
          <form
            className="button-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (customValid) onSet(customValue);
            }}
          >
            <label htmlFor={inputId}>남은 양(ml){volume ? ` · 최대 ${volume}ml` : ""}</label>
            <input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={0}
              max={volume ?? undefined}
              step={1}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
            <button type="submit" disabled={pending || !customValid}>
              저장
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
