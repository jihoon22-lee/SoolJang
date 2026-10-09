/** 소유자를 확인할 수 없는 과거 명령은 원본을 보존하고 활성 대기열에서 분리한다. */
import {
  databaseIdentity,
  db,
  type OutboxEntry,
  type SoolJangDB,
  SYNC_ENTITIES,
  type SyncEntity,
  type SyncRow,
} from "@/sync/db";
import { newId } from "@/sync/uuid7";

const PREFIX = "quarantine:";

export interface QuarantineContext {
  store: SoolJangDB;
  userId: string;
  generation: number;
}

interface ArchivedRow {
  entity: SyncEntity;
  row: SyncRow;
}

interface QuarantineArchive {
  version: 1;
  owner_id: string;
  quarantined_at: string;
  reason: "unverified_owner";
  entries: OutboxEntry[];
  rows: ArchivedRow[];
  /** 부모 행이 보관 대상 밖에 있어도 이미 확인한 다른 소유권을 잊지 않는다. */
  foreign_owned_ids?: string[];
  /** 뒤늦게 적재된 의존 명령도 자동 전송하지 않는다. */
  blocked_ids: string[];
}

export interface QuarantineSummary {
  key: string;
  count: number;
  exportableCount: number;
  unreadable: boolean;
}

export function quarantineContext(): QuarantineContext {
  const identity = databaseIdentity();
  if (!identity.userId) throw new Error("로그인 계정을 확인한 뒤 다시 시도하세요");
  return { store: db, userId: identity.userId, generation: identity.generation };
}

function assertContext(context: QuarantineContext): void {
  const identity = databaseIdentity();
  if (
    !context.userId ||
    context.store !== db ||
    context.userId !== identity.userId ||
    context.generation !== identity.generation
  )
    throw new Error("계정이 변경되어 격리 기록에 접근할 수 없습니다");
}

function decodeArchive(value: string): QuarantineArchive | null {
  try {
    const archive = JSON.parse(value) as QuarantineArchive;
    return archive?.version === 1 &&
      Array.isArray(archive.entries) &&
      archive.entries.every((entry) => entry && typeof entry.idempotency_key === "string") &&
      Array.isArray(archive.rows) &&
      archive.rows.every((item) => item && SYNC_ENTITIES.includes(item.entity) && item.row) &&
      (archive.foreign_owned_ids === undefined || Array.isArray(archive.foreign_owned_ids)) &&
      Array.isArray(archive.blocked_ids)
      ? archive
      : null;
  } catch {
    return null;
  }
}

function visibleOwner(owner: string | undefined, userId: string): boolean {
  return !owner || owner === userId;
}

function references(value: unknown, ids: Set<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => references(item, ids));
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some((item) => references(item, ids))
  );
}

function commandIds(entry: OutboxEntry): string[] {
  return [
    entry.entity_id,
    ...(entry.touched_ids ?? []),
    ...(Array.isArray(entry.fields.bottle_ids)
      ? entry.fields.bottle_ids.filter((id): id is string => typeof id === "string")
      : []),
  ];
}

function referencesParent(row: SyncRow, ids: Set<string>): boolean {
  return Object.entries(row).some(
    ([key, value]) => key !== "user_id" && key.endsWith("_id") && references(value, ids),
  );
}

/** 명령의 빈 소유자보다 대상·부모 행에 명시된 다른 소유권을 우선한다. */
function exportableData(archive: QuarantineArchive, userId: string) {
  const foreignIds = new Set(archive.foreign_owned_ids ?? []);
  for (const { row } of archive.rows)
    if (!visibleOwner(row.user_id, userId)) foreignIds.add(row.id);
  for (const entry of archive.entries)
    if (!visibleOwner(entry.user_id, userId)) foreignIds.add(entry.entity_id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of archive.entries) {
      if (
        !foreignIds.has(entry.entity_id) &&
        (commandIds(entry).some((id) => foreignIds.has(id)) || references(entry.fields, foreignIds))
      ) {
        foreignIds.add(entry.entity_id);
        changed = true;
      }
    }
    for (const { row } of archive.rows) {
      if (!foreignIds.has(row.id) && referencesParent(row, foreignIds)) {
        foreignIds.add(row.id);
        changed = true;
      }
    }
  }
  return {
    entries: archive.entries.filter((entry) => !foreignIds.has(entry.entity_id)),
    rows: archive.rows.filter(({ row }) => !foreignIds.has(row.id)),
  };
}

/** 원본 저장·활성 큐 분리·미러 정리를 한 transaction으로 처리한다. 네트워크 호출은 없다. */
export async function quarantineInvalidEntries(context: QuarantineContext): Promise<number> {
  assertContext(context);
  const { store, userId } = context;
  return store.transaction("rw", store.tables, async () => {
    assertContext(context);
    const queue = await store.outbox.toArray();
    if (queue.length === 0) return 0;
    const affected = new Set<string>();
    for (const saved of await store.sync_meta.where("key").startsWith(PREFIX).toArray()) {
      const archive = decodeArchive(saved.value);
      if (!archive) throw new Error("격리 기록을 읽지 못했습니다. 원본과 대기열은 보존됩니다");
      for (const id of archive.blocked_ids) affected.add(id);
    }
    const selected = new Set<OutboxEntry>();
    for (const entry of queue) {
      if (entry.user_id === userId) continue;
      selected.add(entry);
      for (const id of commandIds(entry)) affected.add(id);
    }
    if (
      selected.size === 0 &&
      !queue.some(
        (entry) =>
          commandIds(entry).some((id) => affected.has(id)) || references(entry.fields, affected),
      )
    )
      return 0;
    const rows = (
      await Promise.all(
        SYNC_ENTITIES.map(async (entity) =>
          (await store.table<SyncRow>(entity).toArray()).map((row) => ({ entity, row })),
        ),
      )
    ).flat();
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of queue) {
        if (
          selected.has(entry) ||
          (!commandIds(entry).some((id) => affected.has(id)) && !references(entry.fields, affected))
        )
          continue;
        selected.add(entry);
        for (const id of commandIds(entry)) affected.add(id);
        changed = true;
      }
      for (const { row } of rows) {
        if (!affected.has(row.id) && referencesParent(row, affected)) {
          affected.add(row.id);
          changed = true;
        }
      }
    }
    if (selected.size === 0) return 0;
    const entries = queue.filter((entry) => selected.has(entry));
    // 이전 격리의 행을 다시 보관하지 않도록 이번 명령의 영향 범위만 구한다.
    const currentIds = new Set(entries.flatMap(commandIds));
    const detachedIds = new Set(
      entries.filter((entry) => entry.op === "create").map((entry) => entry.entity_id),
    );
    for (const entry of entries)
      if (entry.entity === "tasting_session" && entry.action === "record_tasting")
        detachedIds.add(entry.entity_id);
    changed = true;
    while (changed) {
      changed = false;
      for (const { row } of rows) {
        if (!currentIds.has(row.id) && referencesParent(row, currentIds)) {
          currentIds.add(row.id);
          changed = true;
        }
        if (!detachedIds.has(row.id) && referencesParent(row, detachedIds)) {
          detachedIds.add(row.id);
          changed = true;
        }
      }
    }
    const snapshots = rows.filter(({ row }) => currentIds.has(row.id));
    for (const { row } of snapshots) if (row.user_id !== userId) detachedIds.add(row.id);
    const archive: QuarantineArchive = {
      version: 1,
      owner_id: userId,
      quarantined_at: new Date().toISOString(),
      reason: "unverified_owner",
      entries,
      rows: snapshots,
      foreign_owned_ids: rows
        .filter(({ row }) => !visibleOwner(row.user_id, userId))
        .map(({ row }) => row.id),
      blocked_ids: [...new Set([...entries.map((entry) => entry.entity_id), ...detachedIds])],
    };
    await store.sync_meta.add({ key: `${PREFIX}${newId()}`, value: JSON.stringify(archive) });
    const reconcile = new Set<string>(
      JSON.parse((await store.sync_meta.get("reconcile_ids"))?.value ?? "[]"),
    );
    for (const { entity, row } of snapshots) {
      if (detachedIds.has(row.id)) await store.table(entity).delete(row.id);
      else reconcile.add(row.id);
    }
    await store.outbox.bulkDelete(entries.map((entry) => entry.idempotency_key));
    await store.sync_meta.put({ key: "reconcile_ids", value: JSON.stringify([...reconcile]) });
    await store.sync_meta.delete("cursor");
    assertContext(context);
    return entries.length;
  });
}

/** 격리 판정과 전송 후보 읽기 사이에 다른 탭의 쓰기가 끼어들지 않게 한다. */
export async function quarantineAndReadQueue(context: QuarantineContext): Promise<OutboxEntry[]> {
  assertContext(context);
  return context.store.transaction("rw", context.store.tables, async () => {
    await quarantineInvalidEntries(context);
    assertContext(context);
    return context.store.outbox.toArray();
  });
}

/** 목록에는 건수만 전달해 다른 계정의 이름·입력을 표시하지 않는다. */
export async function listQuarantines(context: QuarantineContext): Promise<QuarantineSummary[]> {
  assertContext(context);
  const records = await context.store.sync_meta.where("key").startsWith(PREFIX).toArray();
  assertContext(context);
  return records.map(({ key, value }) => {
    const archive = decodeArchive(value);
    return {
      key,
      count: archive?.entries.length ?? 0,
      exportableCount:
        archive?.owner_id === context.userId
          ? exportableData(archive, context.userId).entries.length
          : 0,
      unreadable: !archive,
    };
  });
}

/** 원래 키와 소유자를 유지한다. 미확인 명령의 재전송·폐기는 제공하지 않는다. */
export async function exportQuarantine(context: QuarantineContext, key: string): Promise<string> {
  assertContext(context);
  if (!key.startsWith(PREFIX)) throw new Error("격리 기록을 찾을 수 없습니다");
  const saved = await context.store.sync_meta.get(key);
  assertContext(context);
  const archive = saved && decodeArchive(saved.value);
  if (!archive || archive.owner_id !== context.userId)
    throw new Error("격리 기록을 안전하게 읽지 못했습니다. 원본은 보존됩니다");
  const { entries, rows } = exportableData(archive, context.userId);
  if (entries.length === 0) throw new Error("다른 계정의 기록은 내보낼 수 없습니다");
  return JSON.stringify(
    {
      version: archive.version,
      quarantined_at: archive.quarantined_at,
      reason: archive.reason,
      entries,
      rows,
    },
    null,
    2,
  );
}
