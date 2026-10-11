import { tastingsApi } from "@/api/client";
import type { TastingLifecycleInput } from "@/api/tastingLifecycle";
import { getCorrectionBlockReason } from "@/sync/corrections";
import { syncEngine } from "@/sync/engine";
import type { WriteSession } from "@/sync/writeSession";

/** ISO times may contain PostgreSQL microseconds; Date alone loses this ordering. */
function timestamp(value: string): number {
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "";
  return Date.parse(value) * 1_000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

export function isNewerTastingVersion(candidate: string, current: string): boolean {
  return timestamp(candidate) > timestamp(current);
}

export async function changeTastingVisibility(
  id: string,
  input: TastingLifecycleInput,
  action: "delete" | "restore",
  session: WriteSession,
  beforeMirror?: () => void,
) {
  if (!navigator.onLine) throw new Error("삭제와 복구는 온라인에서 할 수 있습니다.");
  const blocked = await getCorrectionBlockReason(session, [id]);
  if (blocked) throw new Error(blocked);
  session.assertCurrent();
  const result = await tastingsApi[action === "delete" ? "remove" : "restore"](id, input);
  session.assertCurrent();
  if (result.id !== id || (result.deleted_at === null) !== (action === "restore"))
    throw new Error("시음 변경 응답을 확인할 수 없습니다. 같은 요청으로 다시 시도해 주세요.");
  const store = session.store;
  let superseded = false;
  // A write may have been queued while the request was in flight. Preserve it for sync review.
  await store.transaction(
    "rw",
    [store.outbox, store.tasting_session, store.bottle, store.purchase, store.sku],
    async () => {
      const pending = await getCorrectionBlockReason(session, [id]);
      session.assertCurrent();
      const current = await store.tasting_session.get(id);
      superseded =
        current?.user_id === session.userId &&
        isNewerTastingVersion(current.updated_at, result.updated_at);
      if (superseded) return;
      beforeMirror?.();
      if (!pending && current?.user_id === session.userId) {
        await store.tasting_session.update(id, {
          updated_at: result.updated_at,
          deleted_at: result.deleted_at,
        });
      }
      session.assertCurrent();
    },
  );
  void syncEngine.triggerSync();
  return { ...result, superseded };
}
