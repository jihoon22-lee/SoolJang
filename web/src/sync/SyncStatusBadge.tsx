/**
 * 헤더에 항상 보이는 동기화 상태 배지 + 충돌 확인 패널.
 *
 * 탭과 무관하게 항상 보여야 한다 — 오프라인으로 등록한 술이 실제로 서버에 반영됐는지는
 * 어느 화면에 있든 궁금한 정보다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";

import { syncApi } from "@/api/client";
import { db } from "@/sync/db";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

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

export function SyncStatusBadge() {
  const { state, pendingCount, failedCount, conflictCount, triggerSync } = useSyncStatus();
  const [panelOpen, setPanelOpen] = useState(false);

  const hasConflicts = conflictCount > 0;
  const label = describeStatus({ state, pendingCount, failedCount, conflictCount });
  const tone =
    failedCount > 0 ? "danger" : hasConflicts ? "warn" : state === "offline" ? "muted" : "ok";

  return (
    <div className="sync-status">
      <button
        type="button"
        className={`sync-status-badge sync-status-${tone}`}
        aria-expanded={hasConflicts ? panelOpen : undefined}
        onClick={() => {
          if (hasConflicts) {
            setPanelOpen((open) => !open);
          } else {
            triggerSync();
          }
        }}
      >
        {label}
      </button>
      {/* 마지막 충돌을 확인한 직후에도 "확인할 충돌이 없습니다" 를 보여줘야 하므로
          hasConflicts 가 아니라 panelOpen 에만 걸어 둔다. */}
      {panelOpen && <ConflictPanel onClose={() => setPanelOpen(false)} />}
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
  return "최신 상태";
}

function ConflictPanel({ onClose }: { onClose: () => void }) {
  const conflicts = useLiveQuery(
    () => db.conflict_log.filter((row) => row.deleted_at === null).toArray(),
    [],
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  async function resolve(id: string) {
    setResolvingId(id);
    try {
      await syncApi.resolveConflict(id);
      // 서버가 soft delete 했다 — 다음 풀을 기다리지 않고 바로 반영한다.
      await db.conflict_log.update(id, { deleted_at: new Date().toISOString() });
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="sync-conflict-panel" role="dialog" aria-label="동기화 충돌">
      <div className="sync-conflict-panel-header">
        <h3>동기화 충돌</h3>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>
      {!conflicts || conflicts.length === 0 ? (
        <p className="muted">확인할 충돌이 없습니다.</p>
      ) : (
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
                  내 변경이 서버의 더 최신 값에 밀렸습니다({conflict.server_updated_at as string}).
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
      )}
    </div>
  );
}
