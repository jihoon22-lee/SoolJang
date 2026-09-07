/**
 * Dexie(IndexedDB) 로컬 미러 + outbox.
 *
 * `docs/architecture.md` §1.2 컴포넌트 다이어그램: Dexie 는 로컬 미러와 outbox 를 함께
 * 담는 단일 저장소다. 12개 미러 테이블은 `GET /sync` 가 돌려주는 원자값 그대로를
 * 저장한다(서버 `serialize_row` 와 1:1) — 파생 지표는 `domain/metrics.ts` 가 이 값들로
 * 매번 다시 계산한다(파생값을 저장하지 않는다는 원칙은 클라이언트에도 그대로 적용된다).
 */

import Dexie, { type Table } from "dexie";

/** 모든 동기화 대상 테이블의 공통 컬럼(`docs/architecture.md` §2.2). */
export interface SyncRow {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [key: string]: unknown;
}

export type SyncEntity =
  | "category"
  | "producer"
  | "variety"
  | "product"
  | "product_variety"
  | "sku"
  | "vendor"
  | "purchase"
  | "bottle"
  | "tasting_session"
  | "attachment"
  | "conflict_log";

export const SYNC_ENTITIES: SyncEntity[] = [
  "category",
  "producer",
  "variety",
  "product",
  "product_variety",
  "sku",
  "vendor",
  "purchase",
  "bottle",
  "tasting_session",
  "attachment",
  "conflict_log",
];

/** outbox 에 쌓인 오프라인 작업 하나. 서버 `SyncOperation` 과 필드가 대응한다. */
export interface OutboxEntry {
  idempotency_key: string;
  /** 실패 명령을 새 키로 수정해도 같은 FIFO 위치를 지킨다. */
  sequence_key?: string | undefined;
  /** 대기열 소유자. 구버전 항목은 검증된 로컬 행으로만 복구한다. */
  user_id?: string | undefined;
  entity: SyncEntity;
  op: "create" | "update" | "delete" | "action";
  entity_id: string;
  base_updated_at?: string | undefined;
  action?: string | undefined;
  fields: Record<string, unknown>;
  created_at: string;
  /** 서버로 전송을 시도했는지. FIFO 순서를 지키기 위해 앞 항목이 실패하면 뒤는 시도하지 않는다. */
  status: "pending" | "failed";
  /**
   * `entity_id` 말고 이 작업이 로컬에서 부작용으로 직접 건드리는 다른 엔티티 id들
   * (예: 시음 기록 하나가 병의 잔량·상태도 같이 바꾼다). `pendingEntityIds()` 가
   * `entity_id` 뿐 아니라 이 id들도 "아직 서버에 안 보낸 로컬 변경이 있다"로 보고
   * `pullDeltas` 가 스테일한 서버 값으로 덮지 않게 보호한다.
   */
  touched_ids?: string[] | undefined;
  /** 실패한 경우 서버가 돌려준 사유. UI 에 보여준다. */
  error: string | null;
}

export class SoolJangDB extends Dexie {
  category!: Table<SyncRow, string>;
  producer!: Table<SyncRow, string>;
  variety!: Table<SyncRow, string>;
  product!: Table<SyncRow, string>;
  product_variety!: Table<SyncRow, string>;
  sku!: Table<SyncRow, string>;
  vendor!: Table<SyncRow, string>;
  purchase!: Table<SyncRow, string>;
  bottle!: Table<SyncRow, string>;
  tasting_session!: Table<SyncRow, string>;
  attachment!: Table<SyncRow, string>;
  conflict_log!: Table<SyncRow, string>;
  outbox!: Table<OutboxEntry, string>;
  /** 동기화 커서 등 단일 값 저장. 키는 `"cursor"` 하나뿐이다. */
  sync_meta!: Table<{ key: string; value: string }, string>;

  constructor(name = "sooljang") {
    super(name);
    this.version(1).stores({
      category: "id, parent_id, updated_at, deleted_at",
      producer: "id, updated_at, deleted_at",
      variety: "id, updated_at, deleted_at",
      product: "id, category_id, updated_at, deleted_at",
      product_variety: "id, product_id, variety_id, updated_at",
      sku: "id, product_id, barcode, updated_at, deleted_at",
      vendor: "id, updated_at, deleted_at",
      purchase: "id, sku_id, vendor_id, updated_at, deleted_at",
      bottle: "id, purchase_id, status, updated_at, deleted_at",
      tasting_session: "id, bottle_id, sku_id, updated_at, deleted_at",
      attachment: "id, product_id, bottle_id, tasting_session_id, updated_at",
      conflict_log: "id, entity, entity_id, updated_at, deleted_at",
      outbox: "idempotency_key, created_at, status",
      sync_meta: "key",
    });
  }
}

export let db = new SoolJangDB();
let activeUserId: string | null = null;
let generation = 0;

export function databaseIdentity(): { userId: string | null; generation: number } {
  return { userId: activeUserId, generation };
}

/** 로그아웃은 접근을 잠그며 저장소와 미전송 명령을 삭제하지 않는다. */
export function lockDatabase(): void {
  activeUserId = null;
  generation += 1;
}

/** 인증으로 확인한 사용자 저장소에만 연결한다. 구버전 미러는 소유자별로 보존 이전한다. */
export async function activateDatabase(userId: string): Promise<void> {
  const activation = ++generation;
  activeUserId = null;
  const target = new SoolJangDB(`sooljang-user-${encodeURIComponent(userId)}`);
  await target.open();
  await importLegacyChanges(target, userId);
  if (generation !== activation) {
    target.close();
    return;
  }
  db = target;
  activeUserId = userId;
}

/**
 * 아직 열린 구버전 탭이 나중에 만든 명령도 가져온다. 원본은 삭제하지 않는다.
 * 명령별 영수증은 outbox 성공/폐기 뒤에도 남아 재삽입을 막는다.
 */
export async function importLegacyChanges(target: SoolJangDB, userId: string): Promise<void> {
  if (target.name === "sooljang") return;
  const legacy = new SoolJangDB();
  try {
    await legacy.open();
    if (await target.sync_meta.get("legacy-imported")) {
      const keys = (await legacy.outbox.toArray()).map(
        (entry) => `legacy-command:${entry.idempotency_key}`,
      );
      if ((await target.sync_meta.bulkGet(keys)).every(Boolean)) return;
    }
    const snapshot = await legacy.transaction("r", legacy.tables, async () => ({
      entries: await legacy.outbox.toArray(),
      rows: await Promise.all(
        SYNC_ENTITIES.map((entity) => legacy.table(entity).toArray() as Promise<SyncRow[]>),
      ),
    }));
    const owners = new Map(
      snapshot.rows.flatMap((rows, index) =>
        rows.map((row) => [`${SYNC_ENTITIES[index]}:${row.id}`, row.user_id]),
      ),
    );
    const entries = snapshot.entries.filter((entry) => {
      const rowOwner = owners.get(`${entry.entity}:${entry.entity_id}`);
      return (entry.user_id ?? rowOwner) === userId && (!rowOwner || rowOwner === userId);
    });
    await target.transaction("rw", target.tables, async () => {
      const initialImport = !(await target.sync_meta.get("legacy-imported"));
      const newIds = new Set<string>();
      for (const entry of entries) {
        const receiptKey = `legacy-command:${entry.idempotency_key}`;
        if (await target.sync_meta.get(receiptKey)) continue;
        if (!(await target.outbox.get(entry.idempotency_key))) {
          await target.outbox.add({
            ...entry,
            user_id: userId,
            sequence_key: entry.sequence_key ?? entry.idempotency_key,
          });
          newIds.add(entry.entity_id);
          for (const id of entry.touched_ids ?? []) newIds.add(id);
          for (const id of Array.isArray(entry.fields.bottle_ids) ? entry.fields.bottle_ids : [])
            if (typeof id === "string") newIds.add(id);
        }
        await target.sync_meta.put({ key: receiptKey, value: "1" });
      }
      for (let index = 0; index < SYNC_ENTITIES.length; index += 1) {
        const entity = SYNC_ENTITIES[index];
        if (!entity) continue;
        for (const row of snapshot.rows[index] ?? []) {
          if (row.user_id !== userId || (!initialImport && !newIds.has(row.id))) continue;
          // Existing target rows may include newer server or local edits: never replace them.
          if (!(await target.table(entity).get(row.id))) await target.table(entity).add(row);
        }
      }
      await target.sync_meta.put({ key: "legacy-imported", value: "1" });
    });
  } finally {
    legacy.close();
  }
}

/** 소프트 삭제되지 않은 행만. 대부분의 화면 조회가 이 필터를 쓴다. */
export function isLive(row: SyncRow): boolean {
  return row.deleted_at === null;
}
