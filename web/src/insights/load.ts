import type { InsightSnapshot } from "@/insights/calculate";
import { captureWriteSession } from "@/sync/writeSession";

/** All facts come from one readonly transaction and one account generation. */
export async function loadInsightSnapshot() {
  const session = captureWriteSession();
  session.assertCurrent();
  const store = session.store;
  const tables = [
    store.category,
    store.product,
    store.sku,
    store.purchase,
    store.bottle,
    store.tasting_session,
    store.producer,
    store.vendor,
  ];
  const result = await store.transaction(
    "r",
    [...tables, store.outbox, store.sync_meta],
    async () => {
      const [records, pending, cursor] = await Promise.all([
        Promise.all(tables.map((table) => table.toArray())),
        store.outbox.toArray(),
        store.sync_meta.get("cursor"),
      ]);
      const keys: [
        keyof InsightSnapshot,
        keyof InsightSnapshot,
        keyof InsightSnapshot,
        keyof InsightSnapshot,
        keyof InsightSnapshot,
        keyof InsightSnapshot,
        keyof InsightSnapshot,
        keyof InsightSnapshot,
      ] = [
        "categories",
        "products",
        "skus",
        "purchases",
        "bottles",
        "tastings",
        "producers",
        "vendors",
      ];
      const snapshot = Object.fromEntries(
        keys.map((key, index) => [
          key,
          (records[index] ?? []).filter(
            (row) => row.user_id === session.userId && row.deleted_at === null,
          ),
        ]),
      ) as unknown as InsightSnapshot;
      return {
        snapshot,
        pendingCount: pending.filter((entry) => !entry.user_id || entry.user_id === session.userId)
          .length,
        failedCount: pending.filter(
          (entry) =>
            (!entry.user_id || entry.user_id === session.userId) && entry.status === "failed",
        ).length,
        cursor: cursor?.value ?? null,
      };
    },
  );
  session.assertCurrent();
  return result;
}
