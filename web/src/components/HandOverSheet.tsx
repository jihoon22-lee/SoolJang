/**
 * 증여·판매 기록. 확인창 대신 날짜와 메모를 한 번에 받는다.
 *
 * 증여·판매는 재고에서 빠지는 동작이라 실수 방지가 필요하지만, `window.confirm` 은 날짜를
 * 고칠 수도 받는 사람을 적을 수도 없었다. 서버는 `on`·`note` 를 이미 받는다.
 */

import { useId, useState } from "react";
import { todayLocal } from "@/format";

export type HandOverAction = "gift" | "sell";

export const HAND_OVER_LABELS: Record<HandOverAction, string> = { gift: "증여", sell: "판매" };

export function HandOverSheet({
  action,
  count,
  onConfirm,
  onCancel,
  pending = false,
}: {
  action: HandOverAction;
  count: number;
  onConfirm: (input: { on: string; note: string }) => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const [on, setOn] = useState(todayLocal);
  const [note, setNote] = useState("");
  const dateId = useId();
  const noteId = useId();
  const label = HAND_OVER_LABELS[action];
  return (
    <form
      className="sheet"
      aria-label={`${label} 기록`}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm({ on, note: note.trim() });
      }}
    >
      <p className="mt-0">
        {count > 1 ? `${count}병을` : "이 병을"} {label} 처리합니다. 재고에서 빠지며, 나중에
        "되돌리기"로 다시 재고로 돌릴 수 있습니다.
      </p>
      <label htmlFor={dateId}>{label}한 날</label>
      <input
        id={dateId}
        type="date"
        required
        value={on}
        max={todayLocal()}
        onChange={(event) => setOn(event.target.value)}
      />
      <label htmlFor={noteId}>{action === "gift" ? "받은 사람·메모" : "판매처·메모"} (선택)</label>
      <input
        id={noteId}
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="button-row">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "저장 중…" : `${label} 기록`}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
