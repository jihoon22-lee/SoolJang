/**
 * 동기화 엔진 — outbox 전송 + 델타 풀.
 *
 * `docs/architecture.md` §5.2·§5.3. outbox 는 FIFO 로 전송하고 첫 실패에서 멈춘다
 * (head-of-line blocking — 부모보다 자식이 먼저 도착하면 FK 가 깨진다). 풀은
 * `has_more` 가 false 가 될 때까지 반복하고, 대기 중인 outbox 항목이 있는 행은
 * 서버 값으로 덮어쓰지 않는다(아직 보내지 않은 로컬 변경이 스테일한 풀에 밀리면 안 된다).
 */

import { syncApi } from "@/api/client";
import type { SyncOperationRequest } from "@/api/types";
import { db, SYNC_ENTITIES, type SyncRow } from "@/sync/db";
import { OUTBOX_CHANGED, syncEvents } from "@/sync/events";
import { pendingEntityIds } from "@/sync/outbox";

export type SyncState = "idle" | "syncing" | "offline";

export interface SyncEngineState {
  state: SyncState;
  lastSyncedAt: string | null;
  lastError: string | null;
}

type Listener = (state: SyncEngineState) => void;

//: 풀이 절대 끝나지 않는 버그가 있어도 탭이 멈추지 않게 하는 안전장치.
const MAX_PULL_PAGES = 50;
const POLL_INTERVAL_MS = 60_000;

class SyncEngine {
  private syncing = false;
  private started = false;
  private readonly listeners = new Set<Listener>();
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    syncEvents.addEventListener(OUTBOX_CHANGED, () => void this.triggerSync());
    window.addEventListener("online", () => void this.triggerSync());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.triggerSync();
    });
    window.setInterval(() => {
      if (document.visibilityState === "visible") void this.triggerSync();
    }, POLL_INTERVAL_MS);
    void this.triggerSync();
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async triggerSync(): Promise<void> {
    if (this.syncing) return;
    if (!navigator.onLine) {
      this.emit("offline");
      return;
    }
    this.syncing = true;
    this.emit("syncing");
    try {
      await this.flushOutbox();
      await this.pullDeltas();
      this.lastSyncedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.syncing = false;
      this.emit(navigator.onLine ? "idle" : "offline");
    }
  }

  private snapshot(): SyncEngineState {
    return {
      state: this.syncing ? "syncing" : navigator.onLine ? "idle" : "offline",
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }

  private emit(state: SyncState): void {
    const payload: SyncEngineState = {
      state,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
    for (const listener of this.listeners) listener(payload);
  }

  private async flushOutbox(): Promise<void> {
    const pending = await db.outbox.orderBy("created_at").toArray();
    if (pending.length === 0) return;

    const operations: SyncOperationRequest[] = pending.map((entry) => ({
      idempotency_key: entry.idempotency_key,
      entity: entry.entity,
      op: entry.op,
      entity_id: entry.entity_id,
      base_updated_at: entry.base_updated_at,
      action: entry.action,
      fields: entry.fields,
    }));

    const response = await syncApi.batch(operations);

    for (let i = 0; i < response.results.length; i += 1) {
      const result = response.results[i];
      const entry = pending[i];
      if (!result || !entry) continue;

      if (result.status === "failed") {
        await db.outbox.update(entry.idempotency_key, {
          status: "failed",
          error: result.detail ?? "동기화에 실패했습니다",
        });
        // head-of-line blocking — 이 항목 이후는 큐에 그대로 남겨 다음 시도를 기다린다.
        break;
      }

      // applied 또는 conflict — 서버가 처리를 끝냈다. conflict 면 스냅샷은 "패배한" 클라이언트
      // 값이 아니라 서버가 채택한 현재 값이다(§5.4) — 그대로 로컬 미러에 확정 반영한다.
      if (result.snapshot) {
        await db.table(entry.entity).put(result.snapshot as SyncRow);
      }
      await db.outbox.delete(entry.idempotency_key);
    }
  }

  private async pullDeltas(): Promise<void> {
    let cursor = (await db.sync_meta.get("cursor"))?.value ?? null;

    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const pending = await pendingEntityIds();
      const response = await syncApi.pull(cursor);

      for (const entity of SYNC_ENTITIES) {
        const rows = (response.changes[entity] ?? []) as SyncRow[];
        for (const row of rows) {
          if (pending.has(row.id)) continue;
          await db.table(entity).put(row);
        }
      }

      if (response.next_cursor) {
        cursor = response.next_cursor;
        await db.sync_meta.put({ key: "cursor", value: cursor });
      }
      if (!response.has_more) return;
    }
  }
}

export const syncEngine = new SyncEngine();
