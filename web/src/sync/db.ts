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

class SoolJangDB extends Dexie {
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

  constructor() {
    super("sooljang");
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

export const db = new SoolJangDB();

/** 소프트 삭제되지 않은 행만. 대부분의 화면 조회가 이 필터를 쓴다. */
export function isLive(row: SyncRow): boolean {
  return row.deleted_at === null;
}
