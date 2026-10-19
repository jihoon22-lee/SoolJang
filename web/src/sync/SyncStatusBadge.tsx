/**
 * 헤더에 항상 보이는 동기화 상태 배지 + 충돌 확인 패널.
 *
 * 탭과 무관하게 항상 보여야 한다 — 오프라인으로 등록한 술이 실제로 서버에 반영됐는지는
 * 어느 화면에 있든 궁금한 정보다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { type RefObject, useEffect, useRef, useState } from "react";

import { syncApi } from "@/api/client";
import { databaseIdentity, db, type OutboxEntry } from "@/sync/db";
import {
  dependentEntries,
  discardAllFailedEntries,
  discardFailedEntry,
  replaceFailedEntry,
  retryFailedEntries,
} from "@/sync/outbox";
import { exportQuarantine, listQuarantines, quarantineContext } from "@/sync/quarantine";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { captureWriteSession } from "@/sync/writeSession";
import { useModalDialog } from "@/useModalDialog";

const ENTITY_LABELS: Record<string, string> = {
  category: "주종",
  producer: "생산자",
  variety: "품종",
  product: "제품",
  sku: "규격",
  vendor: "구매처",
  purchase: "구매",
  bottle: "병",
  tasting_session: "시음 기록",
  attachment: "첨부파일",
};

/** outbox `action` 명령의 사람이 읽는 이름. 모르는 명령은 "처리"로 보인다. */
const ACTION_LABELS: Record<string, string> = {
  open: "개봉",
  finish: "소진",
  gift: "증여",
  sell: "판매",
  reopen: "되돌리기",
  unopen: "개봉 취소",
  undo: "실행 취소",
  set_remaining: "잔량 조정",
  move: "위치 이동",
  update: "수정",
  record_tasting: "기록",
};

const FIELD_LABELS: Record<string, string> = {
  name: "이름",
  quantity: "병수",
  volume_ml: "용량(ml)",
  unit_list_price: "병당 정가",
  unit_paid_price: "병당 실구매가",
  note: "메모",
  tasted_on: "마신 날",
  purchased_on: "구매일",
  rating: "평점",
  poured_ml: "시음량(ml)",
  abv: "도수",
  personal_rating: "개인 평점",
  remaining_ml: "남은 양(ml)",
  on: "날짜",
  opened_on: "개봉일",
  finished_on: "소진일",
  vintage: "빈티지",
  age_years: "숙성 연수",
  name_en: "영문 이름",
  country: "국가",
  region: "지역",
  barcode: "바코드",
  package_note: "포장 메모",
  kind: "종류",
  discount_note: "할인 조건",
  currency: "통화",
  fx_rate: "환율",
  foreign_unit_price: "외화 단가",
  place: "장소",
  companions: "함께한 사람",
  nose: "향",
  palate: "맛",
  finish: "여운",
};

/** 내부 식별자·버전 값. 사람이 고칠 값이 아니라 그대로 보존한다. */
function isInternalField(field: string): boolean {
  return (
    field === "id" ||
    field === "revision" ||
    field.endsWith("_id") ||
    field.endsWith("_revision") ||
    field.startsWith("expected_") ||
    field.startsWith("origin_") ||
    field.startsWith("base_")
  );
}

/** 수정 폼에 보일 값. 라벨 목록에 없는 값도 내부 식별자가 아니면 고칠 수 있어야 한다. */
export function editableFields(fields: Record<string, unknown>): [string, string][] {
  return Object.entries(fields)
    .filter(
      ([field, value]) =>
        !isInternalField(field) &&
        (value === null || typeof value === "string" || typeof value === "number"),
    )
    .map(([field, value]) => [field, String(value ?? "")]);
}

/** 비우면 0이 아니라 "값 없음"(null)이어야 하는 숫자 필드. 공란 가격은 0원과 다르게 보존한다. */
const NUMERIC_FIELDS = new Set([
  "remaining_ml",
  "vintage",
  "age_years",
  "fx_rate",
  "foreign_unit_price",
  "quantity",
  "volume_ml",
  "unit_list_price",
  "unit_paid_price",
  "rating",
  "poured_ml",
  "abv",
  "personal_rating",
]);

/** 수정 폼 입력값을 저장할 값으로 바꾼다. 숫자 필드의 공란은 null, 숫자가 아니면 원문을 둬 서버가 거부하게 한다. */
export function correctionValue(field: string, raw: string): string | number | null {
  if (!NUMERIC_FIELDS.has(field)) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : raw;
}

/**
 * 서버(`sync.py::_bounded_int`)가 정수로만 받는 필드. 소수나 숫자가 아닌 값을 넣으면 다시 보내도
 * 같은 이유로 실패해 대기열 맨 앞이 계속 막히므로 바꿔 넣기 전에 막는다. `nullable` 은 비울 수
 * 있는 동작이다 — 개봉(`open`)의 잔량은 비우면 용량으로 시작하지만 잔량 기록(`set_remaining`)은 필수다.
 */
const INTEGER_FIELDS = new Map<string, { nullable: (action: string | undefined) => boolean }>([
  ["remaining_ml", { nullable: (action) => action !== "set_remaining" }],
  ["quantity", { nullable: () => false }],
  ["volume_ml", { nullable: () => false }],
  ["poured_ml", { nullable: () => true }],
  ["vintage", { nullable: () => true }],
]);

/** 저장할 값이 서버에서 다시 실패할 것이 확실하면 그 이유. `action` 은 고치는 병 동작이다. */
export function correctionError(
  field: string,
  value: string | number | null,
  action?: string,
): string | null {
  const integer = INTEGER_FIELDS.get(field);
  if (!integer || (value === null && integer.nullable(action))) return null;
  if (typeof value === "number" && Number.isInteger(value)) return null;
  return `${FIELD_LABELS[field] ?? field}은(는) 정수로 입력하세요`;
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== "string") return "시각 미상";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ko-KR");
}

export function SyncStatusBadge() {
  const {
    state,
    pendingCount,
    failedCount,
    conflictCount,
    quarantineCount,
    triggerSync,
    lastError,
  } = useSyncStatus();
  const [panelOpen, setPanelOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const badgeRef = useRef<HTMLButtonElement | null>(null);

  // 바깥을 클릭하거나 Escape 를 누르면 닫는다. `App.tsx` 설정 메뉴와 같은 패턴이되,
  // 트리거(배지)가 패널의 형제라서 "패널 + 트리거를 감싼 컨테이너(`.sync-status`)" 를
  // 기준으로 잡아야 배지 재클릭이 바깥 클릭으로 오인되지 않는다.
  useEffect(() => {
    if (!panelOpen) return;
    function onPointerDown(event: PointerEvent): void {
      if (!statusRef.current?.contains(event.target as Node)) {
        setPanelOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setPanelOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);

  const hasConflicts = conflictCount > 0;
  const hasFailed = failedCount > 0;
  // 온라인이고 지금 동기화 중도 아닌데 아직 못 보낸 항목이 있다 — 네트워크 오류 등으로
  // `flushOutbox` 자체가 조용히 실패했을 수 있다. 이 경우를 따로 구분하지 않으면
  // "최신 상태" 라고 잘못 표시해 사용자가 반영됐다고 오해한다.
  const stuck = state === "idle" && pendingCount > 0;
  const label =
    lastError && !hasFailed
      ? "동기화 확인 필요"
      : describeStatus({ state, pendingCount, failedCount, conflictCount, quarantineCount });
  const tone =
    failedCount > 0
      ? "danger"
      : hasConflicts || stuck || lastError || quarantineCount > 0
        ? "warn"
        : state === "offline"
          ? "muted"
          : "ok";
  // 보낼 기록이 남아 있으면 무엇이 기다리는지도 볼 수 있게 패널을 연다.
  const opensPanel =
    hasConflicts || hasFailed || Boolean(lastError) || pendingCount > 0 || quarantineCount > 0;

  return (
    <div className="sync-status" ref={statusRef}>
      <button
        type="button"
        ref={badgeRef}
        className={`sync-status-badge sync-status-${tone}`}
        aria-label={label}
        title={label}
        aria-expanded={opensPanel ? panelOpen : undefined}
        aria-haspopup={opensPanel ? "dialog" : undefined}
        aria-controls={opensPanel ? "sync-issues-panel" : undefined}
        onClick={() => {
          if (opensPanel) {
            setPanelOpen((open) => !open);
          } else {
            triggerSync();
          }
        }}
      >
        <span className="sync-status-dot" aria-hidden="true" />
        <span className="sync-status-text">{label}</span>
        {/* 좁은 화면에서는 문구 대신 점과 건수만 보인다(접근성 이름은 문구 그대로). */}
        {failedCount + conflictCount + pendingCount + quarantineCount > 0 ? (
          <span className="sync-status-count" aria-hidden="true">
            {failedCount || conflictCount || quarantineCount || pendingCount}
          </span>
        ) : null}
      </button>
      {/* 마지막 항목을 확인/건너뛴 직후에도 "확인할 게 없습니다" 를 보여줘야 하므로
          opensPanel 이 아니라 panelOpen 에만 걸어 둔다. */}
      {panelOpen && (
        <SyncIssuesPanel onClose={() => setPanelOpen(false)} returnFocusRef={badgeRef} />
      )}
    </div>
  );
}

function describeStatus(status: {
  state: "idle" | "syncing" | "offline";
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  quarantineCount: number;
}): string {
  if (status.failedCount > 0) return `동기화 실패 ${status.failedCount}건`;
  if (status.conflictCount > 0) return `충돌 ${status.conflictCount}건`;
  if (status.quarantineCount > 0) return `보관한 기록 ${status.quarantineCount}건`;
  if (status.state === "syncing") return "동기화 중…";
  if (status.state === "offline") {
    return status.pendingCount > 0 ? `오프라인 (대기 ${status.pendingCount}건)` : "오프라인";
  }
  if (status.pendingCount > 0) return `동기화 대기 ${status.pendingCount}건`;
  return "최신 상태";
}

/** outbox 항목 하나를 사람이 알아볼 수 있는 한 줄로 요약한다. */
function describeEntry(entry: OutboxEntry): string {
  const entityLabel = ENTITY_LABELS[entry.entity] ?? entry.entity;
  const name = entry.fields.name;
  if (typeof name === "string" && name.trim()) return `${entityLabel} · ${name}`;
  const tastedOn = entry.fields.tasted_on;
  if (entry.action === "record_tasting" && typeof tastedOn === "string") {
    return `${entityLabel} · ${tastedOn}`;
  }
  if (entry.action) return `${entityLabel} ${ACTION_LABELS[entry.action] ?? "처리"}`;
  const opLabel = { create: "등록", update: "수정", delete: "삭제", action: "처리" }[entry.op];
  return `${entityLabel} ${opLabel}`;
}

function SyncIssuesPanel({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useModalDialog(returnFocusRef);
  const identity = databaseIdentity();
  const conflicts = useLiveQuery(
    () =>
      db.conflict_log
        .filter((row) => row.deleted_at === null && row.user_id === identity.userId)
        .toArray(),
    [identity.userId, identity.generation],
  );
  const failedEntries = useLiveQuery(
    () =>
      db.outbox
        .where("status")
        .equals("failed")
        .filter((entry) => entry.user_id === identity.userId)
        .toArray(),
    [identity.userId, identity.generation],
  );
  const pendingEntries = useLiveQuery(
    () =>
      db.outbox
        .where("status")
        .equals("pending")
        .filter((entry) => entry.user_id === identity.userId)
        .sortBy("created_at"),
    [identity.userId, identity.generation],
  );
  const quarantines = useLiveQuery(
    () => (identity.userId ? listQuarantines(quarantineContext()) : []),
    [identity.userId, identity.generation],
  );
  const { state, triggerSync, lastError, quarantineCount, pendingCount, failedCount } =
    useSyncStatus();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [discardingKey, setDiscardingKey] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<OutboxEntry | null>(null);
  const [editFields, setEditFields] = useState<Record<string, unknown>>({});
  // 입력 중에는 원문을 그대로 둔다. 매 글자 숫자로 바꾸면 "12." 가 "12" 로 되돌아가 소수점을
  // 칠 수 없다. 보낼 때 고친 값만 바꾼다.
  const [editText, setEditText] = useState<Record<string, string>>({});

  async function downloadQuarantine(key: string) {
    setResolveError(null);
    try {
      const session = captureWriteSession();
      const contents = await exportQuarantine(quarantineContext(), key);
      session.assertCurrent();
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "sooljang-quarantine.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "보관한 기록을 내보내지 못했습니다");
    }
  }

  async function resolve(id: string) {
    setResolvingId(id);
    setResolveError(null);
    try {
      await syncApi.resolveConflict(id);
      // 서버가 soft delete 했다 — 다음 풀을 기다리지 않고 바로 반영한다.
      await db.conflict_log.update(id, { deleted_at: new Date().toISOString() });
    } catch (cause) {
      // catch 가 없으면 실패해도 버튼이 조용히 다시 눌러지는 상태로 돌아갈 뿐이라, 사용자가
      // 반응 없는 버튼을 계속 누르게 된다(B8).
      setResolveError(cause instanceof Error ? cause.message : "충돌 확인에 실패했습니다");
    } finally {
      setResolvingId(null);
    }
  }

  async function discard(entry: OutboxEntry) {
    const dependents = dependentEntries(entry, await db.outbox.toArray());
    const message = dependents.length
      ? `"${describeEntry(entry)}"와 연결된 대기 입력 ${dependents.length}건도 함께 건너뛸까요? 서버에 반영되지 않은 입력이 사라집니다.`
      : `"${describeEntry(entry)}" 항목을 포기하고 건너뛸까요?`;
    if (!window.confirm(message)) return;
    setDiscardingKey(entry.idempotency_key);
    setResolveError(null);
    try {
      await discardFailedEntry(entry.idempotency_key, true);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "건너뛰지 못했습니다");
    } finally {
      setDiscardingKey(null);
    }
  }

  async function saveCorrection() {
    if (!editingEntry) return;
    try {
      const edited = Object.fromEntries(
        editableFields(editFields)
          .filter(
            ([field, original]) => editText[field] !== undefined && editText[field] !== original,
          )
          .map(([field]) => [field, correctionValue(field, editText[field] ?? "")]),
      );
      const invalid = Object.entries(edited)
        .map(([field, value]) => correctionError(field, value, editingEntry.action))
        .find(Boolean);
      if (invalid) {
        setResolveError(invalid);
        return;
      }
      await replaceFailedEntry(editingEntry.idempotency_key, { ...editFields, ...edited });
      setEditingEntry(null);
      setResolveError(null);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "입력을 수정하지 못했습니다");
    }
  }

  async function retryAll() {
    setBulkBusy(true);
    setResolveError(null);
    try {
      await retryFailedEntries();
      triggerSync();
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "다시 보내지 못했습니다");
    } finally {
      setBulkBusy(false);
    }
  }

  async function discardAll() {
    if (
      !window.confirm(
        `실패한 ${failedEntries?.length ?? 0}건과 그 뒤에 연결된 대기 기록을 모두 버릴까요? 서버에 반영되지 않은 입력이 사라집니다.`,
      )
    )
      return;
    setBulkBusy(true);
    setResolveError(null);
    try {
      await discardAllFailedEntries();
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "버리지 못했습니다");
    } finally {
      setBulkBusy(false);
    }
  }

  const hasProblems =
    (conflicts?.length ?? 0) > 0 ||
    (failedEntries?.length ?? 0) > 0 ||
    quarantineCount > 0 ||
    Boolean(lastError);
  const title = hasProblems ? "동기화 문제" : "동기화 상태";
  const nothingToShow =
    conflicts?.length === 0 &&
    failedEntries?.length === 0 &&
    pendingEntries?.length === 0 &&
    pendingCount === 0 &&
    failedCount === 0 &&
    quarantineCount === 0 &&
    !lastError;

  return (
    <div
      className="sync-conflict-panel"
      id="sync-issues-panel"
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="sync-conflict-panel-header">
        <h3>{title}</h3>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>

      {/* 헤더 줄 안에 두면 좁은 화면에서 배지·설정 버튼을 밀어낸다. 패널 안에서 알린다. */}
      {lastError && <p role="alert">{lastError}</p>}
      {resolveError && <p role="alert">{resolveError}</p>}
      {editingEntry && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCorrection();
          }}
        >
          <h4>실패한 입력 수정</h4>
          <p>수정한 값으로 다시 보내며 뒤에 연결된 입력은 그대로 둡니다.</p>
          {/* 내부 식별자(병·규격 id, revision 등)는 사람이 고칠 값이 아니라 그대로 보존한다. */}
          {editableFields(editFields).map(([field, original]) => (
            <label key={field} className="field">
              {FIELD_LABELS[field] ?? field}
              <input
                value={editText[field] ?? original}
                inputMode={NUMERIC_FIELDS.has(field) ? "decimal" : undefined}
                onChange={(event) =>
                  setEditText((previous) => ({ ...previous, [field]: event.target.value }))
                }
              />
            </label>
          ))}
          <div className="button-row">
            <button type="submit">수정 후 다시 시도</button>
            <button type="button" onClick={() => setEditingEntry(null)}>
              취소
            </button>
          </div>
        </form>
      )}
      {nothingToShow && <p className="muted">확인할 문제가 없습니다.</p>}

      {quarantines && quarantines.length > 0 && (
        <section aria-labelledby="sync-quarantine-heading">
          <h4 id="sync-quarantine-heading">별도로 보관한 기록</h4>
          <p>
            계정 소유자를 확인할 수 없는 기록과 연결된 입력의 원본을 보관했습니다. 이 기록은
            자동으로 보내거나 삭제하지 않으며, 관계없는 입력은 계속 동기화합니다.
          </p>
          <ul>
            {quarantines.map((record) => (
              <li key={record.key}>
                <span>
                  {record.unreadable
                    ? "보관한 기록을 읽지 못했습니다. 원본은 보존됩니다."
                    : `따로 보관한 입력 ${record.count}건`}
                </span>
                {record.exportableCount > 0 ? (
                  <button type="button" onClick={() => void downloadQuarantine(record.key)}>
                    내보낼 수 있는 원본 {record.exportableCount}건 저장
                  </button>
                ) : (
                  <span className="muted">이 계정에서 내보낼 수 있는 원본이 없습니다.</span>
                )}
              </li>
            ))}
          </ul>
          <p className="muted text-sm">
            내보내기는 서버 반영 여부를 확인하거나 기록을 다시 보내는 작업이 아닙니다. 다른 계정의
            소유자가 명시된 내용은 포함하지 않습니다.
          </p>
        </section>
      )}

      {failedEntries && failedEntries.length > 0 && (
        <section aria-labelledby="sync-failed-heading">
          <h4 id="sync-failed-heading">실패한 항목</h4>
          <p className="muted text-sm">
            서버가 이 작업을 거부했습니다. 뒤에 쌓인 항목은 이 항목을 정리해야 다시 흐릅니다.
          </p>
          {failedEntries.length > 1 ? (
            <div className="button-row">
              <button type="button" disabled={bulkBusy} onClick={() => void retryAll()}>
                모두 다시 보내기
              </button>
              <button
                type="button"
                className="danger"
                disabled={bulkBusy}
                onClick={() => void discardAll()}
              >
                모두 건너뛰기
              </button>
            </div>
          ) : null}
          <ul>
            {failedEntries.map((entry) => (
              <li key={entry.idempotency_key}>
                <span>{describeEntry(entry)}</span>
                <span className="muted">{entry.error ?? "원인을 알 수 없는 오류입니다."}</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingEntry(entry);
                    setEditFields({ ...entry.fields });
                    setEditText({});
                  }}
                >
                  입력 수정
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={discardingKey === entry.idempotency_key}
                  onClick={() => void discard(entry)}
                >
                  건너뛰기
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pendingEntries && pendingEntries.length > 0 && (
        <section aria-labelledby="sync-pending-heading">
          <h4 id="sync-pending-heading">보낼 기록 {pendingEntries.length}건</h4>
          <p className="muted text-sm">
            {state === "offline"
              ? "오프라인입니다. 연결되면 순서대로 보냅니다."
              : "연결돼 있으면 곧 보냅니다. 오래 남아 있으면 지금 동기화를 눌러 보세요."}
          </p>
          <ul>
            {pendingEntries.slice(0, 20).map((entry) => (
              <li key={entry.idempotency_key}>
                <span>{describeEntry(entry)}</span>
                <span className="muted">{new Date(entry.created_at).toLocaleString("ko-KR")}</span>
              </li>
            ))}
          </ul>
          {pendingEntries.length > 20 ? (
            <p className="muted text-sm">외 {pendingEntries.length - 20}건</p>
          ) : null}
          <button type="button" disabled={state === "offline"} onClick={() => triggerSync()}>
            지금 동기화
          </button>
        </section>
      )}

      {conflicts && conflicts.length > 0 && (
        <section aria-labelledby="sync-conflicts-heading">
          <h4 id="sync-conflicts-heading">동기화 충돌</h4>
          <ul>
            {conflicts.map((conflict) => {
              const snapshot = conflict.client_snapshot as Record<string, unknown> | null;
              const name = typeof snapshot?.name === "string" ? snapshot.name : null;
              const entityLabel =
                ENTITY_LABELS[conflict.entity as string] ?? (conflict.entity as string);
              return (
                <li key={conflict.id}>
                  <span>
                    {entityLabel}
                    {name ? ` · ${name}` : ""}
                  </span>
                  <span className="muted">
                    다른 곳에서 {formatTimestamp(conflict.server_updated_at)}에 먼저 바뀌어 내
                    변경은 반영되지 않았습니다.
                  </span>
                  <button
                    type="button"
                    disabled={resolvingId === conflict.id}
                    onClick={() => void resolve(conflict.id)}
                  >
                    확인
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
