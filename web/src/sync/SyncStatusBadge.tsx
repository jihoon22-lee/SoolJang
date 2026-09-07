/**
 * 헤더에 항상 보이는 동기화 상태 배지 + 충돌 확인 패널.
 *
 * 탭과 무관하게 항상 보여야 한다 — 오프라인으로 등록한 술이 실제로 서버에 반영됐는지는
 * 어느 화면에 있든 궁금한 정보다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { type RefObject, useEffect, useRef, useState } from "react";

import { syncApi } from "@/api/client";
import { db, type OutboxEntry } from "@/sync/db";
import { dependentEntries, discardFailedEntry, replaceFailedEntry } from "@/sync/outbox";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
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
};

export function SyncStatusBadge() {
  const { state, pendingCount, failedCount, conflictCount, triggerSync, lastError } =
    useSyncStatus();
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
      : describeStatus({ state, pendingCount, failedCount, conflictCount });
  const tone =
    failedCount > 0
      ? "danger"
      : hasConflicts || stuck || lastError
        ? "warn"
        : state === "offline"
          ? "muted"
          : "ok";
  const opensPanel = hasConflicts || hasFailed || Boolean(lastError);

  return (
    <div className="sync-status" ref={statusRef}>
      <button
        type="button"
        ref={badgeRef}
        className={`sync-status-badge sync-status-${tone}`}
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
        {label}
      </button>
      {/* 마지막 항목을 확인/건너뛴 직후에도 "확인할 게 없습니다" 를 보여줘야 하므로
          opensPanel 이 아니라 panelOpen 에만 걸어 둔다. */}
      {panelOpen && lastError && <p role="alert">{lastError}</p>}
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
}): string {
  if (status.failedCount > 0) return `동기화 실패 ${status.failedCount}건`;
  if (status.conflictCount > 0) return `충돌 ${status.conflictCount}건`;
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
  if (entry.action) return `${entityLabel} · ${entry.action}`;
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
  const conflicts = useLiveQuery(
    () => db.conflict_log.filter((row) => row.deleted_at === null).toArray(),
    [],
  );
  const failedEntries = useLiveQuery(
    () => db.outbox.where("status").equals("failed").toArray(),
    [],
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [discardingKey, setDiscardingKey] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<OutboxEntry | null>(null);
  const [editFields, setEditFields] = useState<Record<string, unknown>>({});

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
      ? `"${describeEntry(entry)}"와 연결된 대기 명령 ${dependents.length}건을 함께 폐기할까요?`
      : `"${describeEntry(entry)}" 항목을 포기하고 건너뛸까요?`;
    if (!window.confirm(message)) return;
    setDiscardingKey(entry.idempotency_key);
    setResolveError(null);
    try {
      await discardFailedEntry(entry.idempotency_key, true);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "명령을 폐기하지 못했습니다");
    } finally {
      setDiscardingKey(null);
    }
  }

  async function saveCorrection() {
    if (!editingEntry) return;
    try {
      await replaceFailedEntry(editingEntry.idempotency_key, editFields);
      setEditingEntry(null);
      setResolveError(null);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "명령을 수정하지 못했습니다");
    }
  }

  const nothingToShow =
    (!conflicts || conflicts.length === 0) && (!failedEntries || failedEntries.length === 0);

  return (
    <div
      className="sync-conflict-panel"
      id="sync-issues-panel"
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="동기화 문제"
    >
      <div className="sync-conflict-panel-header">
        <h3>동기화 문제</h3>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>

      {resolveError && <p role="alert">{resolveError}</p>}
      {editingEntry && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCorrection();
          }}
        >
          <h4>실패한 입력 수정</h4>
          <p>수정한 값은 새 명령으로 다시 전송하며 뒤의 연결된 입력은 보존합니다.</p>
          {Object.entries(editFields)
            .filter(
              ([, value]) =>
                value === null || typeof value === "string" || typeof value === "number",
            )
            .map(([field, value]) => (
              <label key={field}>
                {FIELD_LABELS[field] ?? field}
                <input
                  value={String(value ?? "")}
                  onChange={(event) =>
                    setEditFields((previous) => ({
                      ...previous,
                      [field]:
                        typeof value === "number" ? Number(event.target.value) : event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          <button type="submit">수정 후 다시 시도</button>
          <button type="button" onClick={() => setEditingEntry(null)}>
            취소
          </button>
        </form>
      )}
      {nothingToShow && <p className="muted">확인할 문제가 없습니다.</p>}

      {failedEntries && failedEntries.length > 0 && (
        <section aria-labelledby="sync-failed-heading">
          <h4 id="sync-failed-heading">실패한 항목</h4>
          <p className="muted text-sm">
            서버가 이 작업을 거부했습니다. 뒤에 쌓인 항목은 이 항목을 정리해야 다시 흐릅니다.
          </p>
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
                    내 변경이 서버의 더 최신 값에 밀렸습니다({conflict.server_updated_at as string}
                    ).
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
