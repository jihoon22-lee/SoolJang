/** 사용자별 outbox를 200개씩 순차 전송하고 확인한 멱등 키만 제거한다. */
import { ApiError, syncApi } from "@/api/client";
import type { SyncBatchResponse, SyncOperationRequest } from "@/api/types";
import {
  databaseIdentity,
  db,
  importLegacyChanges,
  type OutboxEntry,
  type SoolJangDB,
  SYNC_ENTITIES,
  type SyncRow,
} from "@/sync/db";
import { OUTBOX_CHANGED, syncEvents } from "@/sync/events";

export type SyncState = "idle" | "syncing" | "offline";
export interface SyncEngineState {
  state: SyncState;
  lastSyncedAt: string | null;
  lastError: string | null;
}
type Listener = (state: SyncEngineState) => void;
const BATCH_SIZE = 200;
const MAX_PULL_PAGES = 50;
const MAX_FLUSH_BATCHES = 20;
const POLL_INTERVAL_MS = 60_000;
const OUTBOX_DEBOUNCE_MS = 300;

interface Run {
  store: SoolJangDB;
  userId: string;
  generation: number;
  signal: AbortSignal;
}

function ordered(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      (a.sequence_key ?? a.idempotency_key).localeCompare(b.sequence_key ?? b.idempotency_key),
  );
}
function pendingIds(entries: OutboxEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => [entry.entity_id, ...(entry.touched_ids ?? [])]));
}
function validateBatch(
  pending: OutboxEntry[],
  response: SyncBatchResponse,
): Map<string, SyncBatchResponse["results"][number]> {
  const expected = new Set(pending.map((entry) => entry.idempotency_key));
  const results = new Map<string, SyncBatchResponse["results"][number]>();
  for (const result of response.results) {
    if (
      !expected.has(result.idempotency_key) ||
      results.has(result.idempotency_key) ||
      !["applied", "conflict", "failed"].includes(result.status)
    ) {
      throw new Error("동기화 응답의 작업 식별자가 잘못되었습니다. 대기열을 보존했습니다");
    }
    results.set(result.idempotency_key, result);
  }
  const failureIndex = pending.findIndex(
    (entry) => results.get(entry.idempotency_key)?.status === "failed",
  );
  const confirmedLength = failureIndex >= 0 ? failureIndex + 1 : pending.length;
  if (
    response.stopped !== failureIndex >= 0 ||
    results.size !== confirmedLength ||
    pending.slice(0, confirmedLength).some((entry) => !results.has(entry.idempotency_key))
  ) {
    throw new Error("동기화 응답이 일부 누락되었습니다. 미확인 대기열을 보존했습니다");
  }
  return results;
}

export class SyncEngine {
  private syncing = false;
  private dirty = false;
  private started = false;
  private owner: string | null = null;
  private controller: AbortController | null = null;
  private readonly listeners = new Set<Listener>();
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private outboxChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly onOnline = () => void this.triggerSync();
  private readonly onOffline = () => {
    this.controller?.abort();
    this.emit("offline");
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === "visible") void this.triggerSync();
  };
  private readonly onOutbox = () => this.scheduleSyncSoon();

  setUser(userId: string | null): void {
    if (this.owner === userId) return;
    this.controller?.abort();
    this.owner = userId;
    this.lastSyncedAt = null;
    this.lastError = null;
  }
  start(userId?: string): void {
    if (userId) this.setUser(userId);
    if (this.started) return;
    this.started = true;
    syncEvents.addEventListener(OUTBOX_CHANGED, this.onOutbox);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.interval = setInterval(this.onVisibility, POLL_INTERVAL_MS);
    void this.triggerSync();
  }
  stop(): void {
    this.started = false;
    this.dirty = false;
    this.controller?.abort();
    syncEvents.removeEventListener(OUTBOX_CHANGED, this.onOutbox);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.interval !== null) clearInterval(this.interval);
    if (this.outboxChangeTimer !== null) clearTimeout(this.outboxChangeTimer);
    this.interval = null;
    this.outboxChangeTimer = null;
    this.setUser(null);
  }
  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
  private scheduleSyncSoon(): void {
    if (this.outboxChangeTimer !== null) return;
    this.outboxChangeTimer = setTimeout(() => {
      this.outboxChangeTimer = null;
      void this.triggerSync();
    }, OUTBOX_DEBOUNCE_MS);
  }
  private current(run: Run): boolean {
    return (
      !run.signal.aborted &&
      this.owner === run.userId &&
      db === run.store &&
      databaseIdentity().generation === run.generation
    );
  }
  private assertCurrent(run: Run): void {
    if (!this.current(run)) throw new DOMException("동기화 세션이 변경되었습니다", "AbortError");
  }
  async triggerSync(): Promise<void> {
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    if (!this.owner) return;
    if (!navigator.onLine) {
      this.emit("offline");
      return;
    }
    this.syncing = true;
    this.controller = new AbortController();
    const run: Run = {
      store: db,
      userId: this.owner,
      generation: databaseIdentity().generation,
      signal: this.controller.signal,
    };
    this.emit("syncing");
    try {
      // Web Locks is shared across tabs and automatically released on crash/navigation.
      if (navigator.locks) {
        await navigator.locks.request(
          `sooljang-sync:${run.userId}`,
          { ifAvailable: true },
          async (lock) => {
            if (lock) await this.synchronize(run);
          },
        );
      } else {
        // The server still serializes duplicate idempotency keys on older browsers.
        await this.synchronize(run);
      }
    } catch (error) {
      if (this.current(run))
        this.lastError =
          error instanceof ApiError && (error.status === 401 || error.status === 409)
            ? "로그인 계정을 다시 확인하세요. 미전송 입력은 보존됩니다"
            : error instanceof Error
              ? error.message
              : "동기화에 실패했습니다. 대기열은 보존됩니다";
    } finally {
      this.syncing = false;
      this.emit(navigator.onLine ? "idle" : "offline");
      if (this.dirty) {
        this.dirty = false;
        void this.triggerSync();
      }
    }
  }
  private async synchronize(run: Run): Promise<void> {
    this.assertCurrent(run);
    await importLegacyChanges(run.store, run.userId);
    this.assertCurrent(run);
    await this.flushOutbox(run);
    await this.pullDeltas(run);
    this.assertCurrent(run);
    this.lastSyncedAt = new Date().toISOString();
    this.lastError = null;
  }
  private snapshot(): SyncEngineState {
    return {
      state: this.syncing ? "syncing" : navigator.onLine ? "idle" : "offline",
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }
  private emit(state: SyncState): void {
    for (const listener of this.listeners) listener({ ...this.snapshot(), state });
  }
  private async flushOutbox(run: Run): Promise<void> {
    const store = run.store;
    for (let batch = 0; batch < MAX_FLUSH_BATCHES; batch += 1) {
      this.assertCurrent(run);
      const queue = ordered(await store.outbox.toArray());
      if (queue.length === 0) return;
      const failedIndex = queue.findIndex((entry) => entry.status === "failed");
      if (failedIndex === 0)
        throw new Error("실패한 명령을 수정하거나 의존 항목과 함께 폐기하세요");
      const candidates = queue.slice(
        0,
        Math.min(BATCH_SIZE, failedIndex < 0 ? queue.length : failedIndex),
      );
      const pending: OutboxEntry[] = [];
      const touched = new Set<string>();
      for (const candidate of candidates) {
        const ids = [candidate.entity_id, ...(candidate.touched_ids ?? [])];
        if (ids.some((id) => touched.has(id))) break;
        pending.push(candidate);
        for (const id of ids) touched.add(id);
      }
      if (pending.some((entry) => entry.user_id !== run.userId))
        throw new Error("다른 계정의 대기열은 전송할 수 없습니다");
      const operations: SyncOperationRequest[] = pending.map((entry) => ({
        idempotency_key: entry.idempotency_key,
        entity: entry.entity,
        op: entry.op,
        entity_id: entry.entity_id,
        base_updated_at: entry.base_updated_at,
        action: entry.action,
        fields: entry.fields,
      }));
      const response = await syncApi.batch(operations, run.userId, run.signal);
      this.assertCurrent(run);
      const results = validateBatch(pending, response);
      await store.transaction(
        "rw",
        [store.outbox, ...SYNC_ENTITIES.map((entity) => store.table(entity))],
        async () => {
          this.assertCurrent(run);
          const currentQueue = ordered(await store.outbox.toArray());
          for (const entry of pending) {
            const result = results.get(entry.idempotency_key);
            if (!result) break;
            const current = await store.outbox.get(entry.idempotency_key);
            if (!current) continue;
            if (result.status === "failed") {
              await store.outbox.update(entry.idempotency_key, {
                status: "failed",
                error: result.detail ?? "동기화에 실패했습니다",
              });
              break;
            }
            const later = currentQueue.slice(
              currentQueue.findIndex((other) => other.idempotency_key === entry.idempotency_key) +
                1,
            );
            const protectedIds = pendingIds(later);
            if (result.snapshot) {
              const row = result.snapshot as SyncRow;
              if (row.id !== entry.entity_id || row.user_id !== run.userId)
                throw new Error("동기화 응답의 소유자 또는 대상이 다릅니다");
              if (!protectedIds.has(row.id)) {
                const local = (await store.table(entry.entity).get(row.id)) as SyncRow | undefined;
                if (
                  !local ||
                  local.updated_at <= row.updated_at ||
                  !later.some((other) => other.entity_id === row.id)
                )
                  await store.table(entry.entity).put(row);
              }
              // A later edit is based on the just-confirmed local command, not a stale version.
              const next = later.find((other) => other.entity_id === entry.entity_id);
              if (next && result.status === "applied")
                await store.outbox.update(next.idempotency_key, {
                  base_updated_at: row.updated_at,
                });
            }
            await store.outbox.delete(entry.idempotency_key);
          }
        },
      );
      if (response.stopped) throw new Error("일부 명령이 실패했습니다. 뒤의 대기열은 보존됩니다");
    }
    this.dirty = true;
  }
  private async pullDeltas(run: Run): Promise<void> {
    const store = run.store;
    const startCursor = (await store.sync_meta.get("cursor"))?.value ?? null;
    let cursor = startCursor;
    const accumulated = new Map<(typeof SYNC_ENTITIES)[number], SyncRow[]>();
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await syncApi.pull(cursor, run.userId, run.signal);
      this.assertCurrent(run);
      for (const entity of SYNC_ENTITIES) {
        const rows = (response.changes[entity] ?? []) as SyncRow[];
        if (rows.some((row) => row.user_id !== run.userId))
          throw new Error("다른 계정의 동기화 응답은 반영하지 않습니다");
        accumulated.set(entity, [...(accumulated.get(entity) ?? []), ...rows]);
      }
      if (response.has_more && (!response.next_cursor || response.next_cursor === cursor))
        throw new Error("동기화 커서가 진행되지 않습니다");
      if (response.next_cursor) cursor = response.next_cursor;
      if (!response.has_more) break;
    }
    await store.transaction(
      "rw",
      [store.outbox, store.sync_meta, ...SYNC_ENTITIES.map((entity) => store.table(entity))],
      async () => {
        this.assertCurrent(run);
        const protectedIds = pendingIds(await store.outbox.toArray());
        const reconcile = new Set<string>(
          JSON.parse((await store.sync_meta.get("reconcile_ids"))?.value ?? "[]"),
        );
        for (const entity of SYNC_ENTITIES) {
          for (const row of accumulated.get(entity) ?? []) {
            if (protectedIds.has(row.id)) continue;
            const local = (await store.table(entity).get(row.id)) as SyncRow | undefined;
            if (
              !local ||
              reconcile.has(row.id) ||
              Date.parse(local.updated_at) <= Date.parse(row.updated_at)
            )
              await store.table(entity).put(row);
            reconcile.delete(row.id);
          }
        }
        await store.sync_meta.put({ key: "reconcile_ids", value: JSON.stringify([...reconcile]) });
        if (cursor !== null && cursor !== startCursor)
          await store.sync_meta.put({ key: "cursor", value: cursor });
      },
    );
  }
}
export const syncEngine = new SyncEngine();
