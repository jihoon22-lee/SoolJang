/**
 * 동기화 상태를 화면에 노출하는 컨텍스트.
 *
 * `useLiveQuery` 로 `db.outbox`/`db.conflict_log` 를 구독해 대기·실패·충돌 건수를
 * 반응형으로 보여준다 — 폴링 없이 Dexie 쓰기가 있을 때만 재계산된다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { db } from "@/sync/db";
import { type SyncEngineState, syncEngine } from "@/sync/engine";

export interface SyncStatus extends SyncEngineState {
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  triggerSync: () => void;
}

const SyncStatusContext = createContext<SyncStatus | null>(null);

const INITIAL_ENGINE_STATE: SyncEngineState = {
  state: "idle",
  lastSyncedAt: null,
  lastError: null,
};

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [engineState, setEngineState] = useState<SyncEngineState>(INITIAL_ENGINE_STATE);

  useEffect(() => {
    syncEngine.start();
    return syncEngine.onStateChange(setEngineState);
  }, []);

  const pendingCount =
    useLiveQuery(() => db.outbox.where("status").equals("pending").count(), []) ?? 0;
  const failedCount =
    useLiveQuery(() => db.outbox.where("status").equals("failed").count(), []) ?? 0;
  const conflictCount =
    useLiveQuery(() => db.conflict_log.filter((row) => row.deleted_at === null).count(), []) ?? 0;

  const value: SyncStatus = {
    ...engineState,
    pendingCount,
    failedCount,
    conflictCount,
    triggerSync: () => void syncEngine.triggerSync(),
  };

  return <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>;
}

export function useSyncStatus(): SyncStatus {
  const context = useContext(SyncStatusContext);
  if (!context) {
    throw new Error("useSyncStatus 는 SyncStatusProvider 안에서만 쓸 수 있습니다");
  }
  return context;
}
