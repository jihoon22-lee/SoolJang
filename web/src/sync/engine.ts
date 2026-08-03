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
//: outbox 쓰기 직후 몇 번 더 이어지는 경우(연속 클릭, 낙관적 갱신 뒤 결과 반영)를 한
//: triggerSync 로 묶는다. 값 자체보다 "즉시 발화하지 않는다"는 점이 성능에 중요하다.
const OUTBOX_DEBOUNCE_MS = 300;

class SyncEngine {
  private syncing = false;
  //: 진행 중인 동기화가 끝나기 전에 새 트리거가 도착했다는 표시. 그 트리거를 그냥
  //: 버리면(기존 버그) 해당 쓰기가 다음 60초 폴링이나 visibilitychange/online 이벤트
  //: 까지(탭이 백그라운드면 그마저도 없이 무기한) 미뤄진다 — `finally` 에서 확인해
  //: 한 번 더 돈다.
  private dirty = false;
  private started = false;
  private readonly listeners = new Set<Listener>();
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private outboxChangeTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    syncEvents.addEventListener(OUTBOX_CHANGED, () => this.scheduleSyncSoon());
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

  /**
   * outbox 변경을 짧게 묶어 한 번만 동기화한다.
   *
   * 병 하나를 소진 처리하는 클릭 한 번이 outbox 쓰기 하나로 끝나지 않는다 — 낙관적 갱신 →
   * 서버 응답 반영 → 델타 풀이 뒤이어 각자 outbox/테이블을 건드릴 수 있다. 매번 즉시
   * `triggerSync` 를 부르면 그 사이 자잘한 네트워크 왕복이 겹친다.
   */
  private scheduleSyncSoon(): void {
    if (this.outboxChangeTimer !== null) return;
    this.outboxChangeTimer = setTimeout(() => {
      this.outboxChangeTimer = null;
      void this.triggerSync();
    }, OUTBOX_DEBOUNCE_MS);
  }

  async triggerSync(): Promise<void> {
    if (this.syncing) {
      // 지금 도는 동기화가 이미 이전 스냅샷으로 flushOutbox 를 마쳤을 수 있다 — 이
      // 트리거는 조용히 버리지 않고 이번 회차가 끝난 뒤 한 번 더 돈다(아래 finally).
      this.dirty = true;
      return;
    }
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
      if (this.dirty) {
        this.dirty = false;
        void this.triggerSync();
      }
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

    // 결과 적용을 트랜잭션 하나로 묶는다. 낱개로 `put`/`delete` 하면 각각이 별도
    // 트랜잭션이 되어 `useLiveQuery` 구독자가 항목 수만큼 재평가된다 — 병 하나를 소진
    // 처리하는 클릭 한 번에도 405개 제품 지표가 여러 번 다시 계산돼 프레임이 끊겼다.
    await db.transaction(
      "rw",
      [db.outbox, ...SYNC_ENTITIES.map((entity) => db.table(entity))],
      async () => {
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

          // applied 또는 conflict — 서버가 처리를 끝냈다. conflict 면 스냅샷은 "패배한"
          // 클라이언트 값이 아니라 서버가 채택한 현재 값이다(§5.4) — 그대로 로컬 미러에
          // 확정 반영한다.
          if (result.snapshot) {
            await db.table(entry.entity).put(result.snapshot as SyncRow);
          }
          await db.outbox.delete(entry.idempotency_key);
        }
      },
    );
  }

  private async pullDeltas(): Promise<void> {
    let cursor = (await db.sync_meta.get("cursor"))?.value ?? null;

    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await syncApi.pull(cursor);

      // pending 조회와 행 적용을 같은 트랜잭션으로 묶는다(outbox 도 테이블 목록에 넣어
      // 트랜잭션 범위 안에서 읽는다). `syncApi.pull` 네트워크 왕복을 기다리는 동안
      // 사용자가 만든 낙관적 쓰기는 그 왕복 시작 시점의 스냅샷에 없다 — pending 조회를
      // pull *이후*, 그리고 행 적용과 같은 트랜잭션 안에서 하지 않으면, 그 사이에 생긴
      // 낙관적 쓰기가 스테일한 서버 값에 덮인다(TOCTOU).
      await db.transaction(
        "rw",
        [db.outbox, ...SYNC_ENTITIES.map((entity) => db.table(entity))],
        async () => {
          const pending = await pendingEntityIds();
          for (const entity of SYNC_ENTITIES) {
            const rows = (response.changes[entity] ?? []) as SyncRow[];
            for (const row of rows) {
              if (pending.has(row.id)) continue;
              await db.table(entity).put(row);
            }
          }
        },
      );

      if (response.next_cursor) {
        cursor = response.next_cursor;
        await db.sync_meta.put({ key: "cursor", value: cursor });
      }
      if (!response.has_more) return;
    }
  }
}

export const syncEngine = new SyncEngine();
