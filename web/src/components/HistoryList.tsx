/**
 * 변경 이력 — "언제 열었고, 언제 다 마셨다고 눌렀다가 되돌렸나" 를 사람이 읽는 문장으로.
 *
 * 서버 `record_event`(+ 병 위치 이동)를 펼쳐 볼 때만 불러온다. 이력은 서버에만 있으므로
 * 온라인에서만 보인다.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { HistoryEntry } from "@/api/types";
import { formatMoney } from "@/format";

const ACTION_LABELS: Record<string, string> = {
  open: "개봉",
  finish: "소진",
  gift: "증여",
  sell: "판매",
  reopen: "되돌리기",
  unopen: "개봉 취소",
  undo: "실행 취소",
  set_remaining: "잔량 조정",
  tasting: "시음",
  move: "위치 이동",
  update: "수정",
};

const FIELD_LABELS: Record<string, string> = {
  status: "상태",
  opened_on: "개봉일",
  finished_on: "소진·처분일",
  remaining_ml: "잔량(ml)",
  quantity: "병수",
  unit_list_price: "병당 정가",
  unit_paid_price: "병당 실구매가",
  purchased_on: "구매일",
  vendor_id: "구매처",
  discount_note: "할인 메모",
  poured_ml: "따른 양(ml)",
  tasted_on: "마신 날",
  note: "메모",
};

const STATUS_LABELS: Record<string, string> = {
  unopened: "미개봉",
  open: "개봉",
  finished: "소진",
  gifted: "증여",
  sold: "판매",
};

const MONEY_FIELDS = new Set(["unit_list_price", "unit_paid_price"]);
const REFERENCE_FALLBACK: Record<string, string> = {
  vendor_id: "지운 구매처",
  from_location_id: "지운 위치",
  to_location_id: "지운 위치",
};

function show(field: string, value: unknown, labels: Record<string, string>): string {
  const fallback = REFERENCE_FALLBACK[field];
  if (fallback !== undefined) {
    if (value === null || value === undefined || value === "") {
      return field === "vendor_id" ? "없음" : "미지정";
    }
    return labels[String(value)] ?? fallback;
  }
  if (value === null || value === undefined || value === "") return "없음";
  if (field === "status" && typeof value === "string") return STATUS_LABELS[value] ?? value;
  if (MONEY_FIELDS.has(field)) return formatMoney(String(value));
  return String(value);
}

/** 이력 한 줄의 바뀐 칸 설명. [이전, 이후] 쌍은 "이전 → 이후" 로, 나머지는 값 그대로. */
export function describeHistory(entry: HistoryEntry): string {
  const parts: string[] = [];
  const labels = entry.labels ?? {};
  if ("from_location_id" in entry.detail || "to_location_id" in entry.detail) {
    const from = show("from_location_id", entry.detail.from_location_id, labels);
    const to = show("to_location_id", entry.detail.to_location_id, labels);
    // 동작 이름이 이미 "위치 이동"이라 앞에 칸 이름을 붙이지 않는다.
    parts.push(`${from} → ${to}`);
  }
  for (const [field, value] of Object.entries(entry.detail)) {
    if (
      field === "from_location_id" ||
      field === "to_location_id" ||
      field === "origin_operation_id"
    )
      continue;
    const label = FIELD_LABELS[field] ?? field;
    if (Array.isArray(value) && value.length === 2) {
      parts.push(`${label} ${show(field, value[0], labels)} → ${show(field, value[1], labels)}`);
    } else {
      parts.push(`${label} ${show(field, value, labels)}`);
    }
  }
  return parts.join(" · ");
}

/** 펼칠 때만 이력을 불러오는 접힘 영역. */
export function HistoryDetails({
  title = "변경 이력",
  queryKey,
  load,
  online,
}: {
  title?: string;
  queryKey: readonly unknown[];
  load: (signal: AbortSignal) => Promise<HistoryEntry[]>;
  online: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="history-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open ? <HistoryList queryKey={queryKey} load={load} enabled={online} /> : null}
    </details>
  );
}

export function HistoryList({
  queryKey,
  load,
  enabled,
}: {
  queryKey: readonly unknown[];
  load: (signal: AbortSignal) => Promise<HistoryEntry[]>;
  enabled: boolean;
}) {
  const history = useQuery({
    queryKey,
    queryFn: ({ signal }) => load(signal),
    enabled,
  });
  if (!enabled) return <p className="muted text-sm">변경 이력은 온라인에서 볼 수 있습니다.</p>;
  if (history.isPending) return <output>이력을 불러오는 중…</output>;
  if (history.isError) return <p className="muted text-sm">이력을 불러오지 못했습니다.</p>;
  if (history.data.length === 0) return <p className="muted text-sm">아직 남은 이력이 없습니다.</p>;
  return (
    <ol className="history-list">
      {history.data.map((entry, index) => (
        // 서버 이력은 id 없이 시간순으로만 온다 — 시각과 순번을 함께 키로 쓴다.
        <li key={`${entry.at}-${index}`}>
          <span className="history-when">{new Date(entry.at).toLocaleString("ko-KR")}</span>
          <strong>{ACTION_LABELS[entry.action] ?? entry.action}</strong>
          <span className="muted">{describeHistory(entry)}</span>
        </li>
      ))}
    </ol>
  );
}
