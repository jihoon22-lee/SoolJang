import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tastingsApi } from "@/api/client";
import { activateDatabase, db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";
import { changeTastingVisibility } from "@/sync/tastingLifecycle";
import { captureWriteSession } from "@/sync/writeSession";

const before = "2026-10-01T00:00:00.000001Z";
const after = "2026-10-01T00:00:00.000002Z";
const input = { request_id: "delete-request", expected_updated_at: before };
beforeEach(async () => {
  await activateDatabase("tasting-owner");
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
  vi.spyOn(syncEngine, "triggerSync").mockResolvedValue();
  await db.tasting_session.put({
    id: "t",
    user_id: "tasting-owner",
    created_at: before,
    updated_at: before,
    deleted_at: null,
    bottle_id: null,
    sku_id: "sku",
    note: "기억할 메모",
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});
it("삭제 확인 뒤 미러를 갱신해 즉시 오프라인 조회에서도 지워진다", async () => {
  vi.spyOn(tastingsApi, "remove").mockResolvedValue({
    id: "t",
    updated_at: after,
    deleted_at: after,
  });
  await changeTastingVisibility("t", input, "delete", captureWriteSession());
  expect((await db.tasting_session.get("t"))?.deleted_at).toBe(after);
  expect((await db.tasting_session.get("t"))?.note).toBe("기억할 메모");
});
it("늦은 삭제 receipt가 더 최신인 로컬 복구본을 덮지 않는다", async () => {
  const newer = "2026-10-01T00:00:00.000003Z";
  await db.tasting_session.update("t", { updated_at: newer });
  vi.spyOn(tastingsApi, "remove").mockResolvedValue({
    id: "t",
    updated_at: after,
    deleted_at: after,
  });
  const onDeleted = vi.fn();
  const result = await changeTastingVisibility(
    "t",
    input,
    "delete",
    captureWriteSession(),
    onDeleted,
  );
  expect(onDeleted).not.toHaveBeenCalled();
  expect(result).toMatchObject({ superseded: true });
  expect((await db.tasting_session.get("t"))?.deleted_at).toBeNull();
  expect((await db.tasting_session.get("t"))?.updated_at).toBe(newer);
});
it("복구는 같은 기록의 삭제 표시만 지우며 잔량은 건드리지 않는다", async () => {
  await db.tasting_session.update("t", { updated_at: after, deleted_at: after });
  vi.spyOn(tastingsApi, "restore").mockResolvedValue({
    id: "t",
    updated_at: "2026-10-02T00:00:00Z",
    deleted_at: null,
  });
  await changeTastingVisibility(
    "t",
    { ...input, expected_updated_at: after },
    "restore",
    captureWriteSession(),
  );
  expect((await db.tasting_session.get("t"))?.deleted_at).toBeNull();
  expect(await db.bottle.count()).toBe(0);
});
it("삭제 응답 중 계정 전환이면 새 계정 미러를 바꾸지 않는다", async () => {
  const session = captureWriteSession();
  vi.spyOn(tastingsApi, "remove").mockImplementation(async () => {
    await activateDatabase("other-owner");
    return { id: "t", updated_at: after, deleted_at: after };
  });
  await expect(changeTastingVisibility("t", input, "delete", session)).rejects.toThrow();
  expect(await db.tasting_session.get("t")).toBeUndefined();
});
