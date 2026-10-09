import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyBottleTransition,
  applyBottleTransitions,
  canTransition,
  undoBottleTransitions,
} from "@/sync/bottleActions";
import { confirmedBottleOperationKey } from "@/sync/bottleRevision";
import { activateDatabase, db } from "@/sync/db";
import { recordTasting } from "@/sync/tastingActions";

const NOW = "2026-01-01T00:00:00Z";
function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    user_id: "u1",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

async function seedBottle(id: string, status: string, extra: Record<string, unknown> = {}) {
  await db.bottle.put(
    row({
      id,
      purchase_id: "pu1",
      revision: "00000000-0000-4000-8000-000000000001",
      label_no: 1,
      status,
      opened_on: status === "unopened" ? null : "2026-01-02",
      finished_on: null,
      remaining_ml: status === "open" ? 400 : null,
      ...extra,
    }),
  );
}

beforeEach(async () => {
  await activateDatabase("u1");
  await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 700 }));
  await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 3 }));
});

afterEach(async () => {
  await Promise.all([
    db.bottle.clear(),
    db.outbox.clear(),
    db.sku.clear(),
    db.purchase.clear(),
    db.tasting_session.clear(),
    db.sync_meta.clear(),
  ]);
});

describe("canTransition", () => {
  it("서버 상태 전이 규칙과 같다", () => {
    expect(canTransition("unopened", "open")).toBe(true);
    expect(canTransition("finished", "open")).toBe(false);
    expect(canTransition("finished", "reopen")).toBe(true);
    expect(canTransition("open", "unopen")).toBe(true);
    expect(canTransition("gifted", "finish")).toBe(false);
    expect(canTransition("open", "set_remaining")).toBe(true);
  });
});

describe("applyBottleTransitions", () => {
  it("할 수 있는 병만 적용하고 나머지는 건너뛴다", async () => {
    await seedBottle("b1", "unopened");
    await seedBottle("b2", "finished");

    const result = await applyBottleTransitions(["b1", "b2"], "open");

    expect(result.applied.map((item) => item.id)).toEqual(["b1"]);
    expect(result.skipped).toEqual(["b2"]);
    expect((await db.bottle.get("b1"))?.remaining_ml).toBe(700);
    expect(await db.outbox.count()).toBe(1);
  });

  it("증여에 날짜·메모를 담는다", async () => {
    await seedBottle("b1", "unopened");

    await applyBottleTransitions(["b1"], "gift", { on: "2026-09-30", note: "친구" });

    const [entry] = await db.outbox.toArray();
    expect(entry?.fields).toEqual({ on: "2026-09-30", note: "친구" });
    expect((await db.bottle.get("b1"))?.finished_on).toBe("2026-09-30");
  });
});

describe("undoBottleTransitions", () => {
  it("미개봉에서 증여한 병은 원명령을 참조한 단일 취소로 복원한다", async () => {
    await seedBottle("b1", "unopened");
    const result = await applyBottleTransitions(["b1"], "gift");

    await undoBottleTransitions(result.applied);

    expect((await db.bottle.get("b1"))?.status).toBe("unopened");
    const actions = (await db.outbox.toArray()).map((entry) => entry.action);
    expect(actions).toEqual(["gift", "undo"]);
  });

  it("개봉 병을 소진했다 되돌리면 알던 잔량을 복원한다", async () => {
    await seedBottle("b1", "open");
    const result = await applyBottleTransitions(["b1"], "finish");

    await undoBottleTransitions(result.applied);

    const bottle = await db.bottle.get("b1");
    expect(bottle?.status).toBe("open");
    expect(bottle?.remaining_ml).toBe(400);
  });

  it("잔량 조정은 상태 대신 이전 잔량으로 되돌린다", async () => {
    await seedBottle("b1", "open");
    const result = await applyBottleTransitions(["b1"], "set_remaining", { remainingMl: 100 });

    await undoBottleTransitions(result.applied);

    expect((await db.bottle.get("b1"))?.remaining_ml).toBe(400);
  });
});

it("개봉 뒤 시음한 병은 오래된 개봉 취소가 덮어쓰지 않는다", async () => {
  await seedBottle("b1", "unopened");
  const opened = await applyBottleTransitions(["b1"], "open");
  await recordTasting({
    bottleId: "b1",
    userId: "u1",
    tastedOn: "2026-01-02",
    pouredMl: 30,
    rating: null,
  });
  expect(await undoBottleTransitions(opened.applied)).toEqual({ applied: [], skipped: ["b1"] });
  expect((await db.bottle.get("b1"))?.remaining_ml).toBe(670);
  expect(await db.tasting_session.count()).toBe(1);
  expect((await db.outbox.toArray()).map((x) => x.action)).toEqual(["open", "record_tasting"]);
});

it("양 없는 시음도 이전 동작의 취소를 막고 다른 병은 취소할 수 있다", async () => {
  await seedBottle("b1", "unopened");
  await seedBottle("b2", "unopened");
  const opened = await applyBottleTransitions(["b1", "b2"], "open");
  await recordTasting({
    bottleId: "b1",
    userId: "u1",
    tastedOn: "2026-01-02",
    pouredMl: null,
    rating: "4",
    nose: "향",
  });
  expect(await undoBottleTransitions(opened.applied)).toEqual({ applied: ["b2"], skipped: ["b1"] });
  expect((await db.bottle.get("b1"))?.status).toBe("open");
  expect((await db.bottle.get("b2"))?.status).toBe("unopened");
});

it("확인된 원명령 이후 서버 revision이 바뀌면 같은 값으로 돌아왔어도 취소하지 않는다", async () => {
  await seedBottle("b1", "unopened");
  const opened = await applyBottleTransitions(["b1"], "open");
  const operationId = opened.applied[0]?.operationId;
  await db.outbox.clear();
  await db.sync_meta.put({
    key: confirmedBottleOperationKey("b1"),
    value: JSON.stringify({ operationId, revision: "confirmed", status: "applied" }),
  });
  await db.bottle.update("b1", { revision: "later" });
  expect(await undoBottleTransitions(opened.applied)).toEqual({ applied: [], skipped: ["b1"] });
  expect(await db.outbox.count()).toBe(0);
});

it("확인된 정상 동작 취소는 revision을 보내고 두 번 적재하지 않는다", async () => {
  await seedBottle("b1", "unopened");
  const opened = await applyBottleTransitions(["b1"], "open");
  const operationId = opened.applied[0]?.operationId;
  await db.outbox.clear();
  await db.bottle.update("b1", { revision: "confirmed" });
  await db.sync_meta.put({
    key: confirmedBottleOperationKey("b1"),
    value: JSON.stringify({ operationId, revision: "confirmed", status: "applied" }),
  });
  expect((await undoBottleTransitions(opened.applied)).applied).toEqual(["b1"]);
  expect((await undoBottleTransitions(opened.applied)).skipped).toEqual(["b1"]);
  const [entry] = await db.outbox.toArray();
  expect(entry?.fields).toEqual({
    origin_operation_id: operationId,
    expected_revision: "confirmed",
  });
});

it("오프라인 잔량 정정은 앞선 시음 명령의 확인 revision을 참조한다", async () => {
  await seedBottle("b1", "open");
  await recordTasting({
    bottleId: "b1",
    userId: "u1",
    tastedOn: "2026-01-02",
    pouredMl: 30,
    rating: null,
  });
  const [tasting] = await db.outbox.toArray();
  await applyBottleTransition("b1", "set_remaining", { remainingMl: 350 });
  const remaining = (await db.outbox.toArray()).find((x) => x.action === "set_remaining");
  expect(remaining?.fields.expected_operation_id).toBe(tasting?.idempotency_key);
});

it("서버 revision도 선행 명령도 없는 과거 미러에서는 잔량을 덮어쓰지 않는다", async () => {
  await seedBottle("b1", "open", { revision: undefined });
  await expect(applyBottleTransition("b1", "set_remaining", { remainingMl: 10 })).rejects.toThrow(
    "최신 병 상태",
  );
  expect((await db.bottle.get("b1"))?.remaining_ml).toBe(400);
  expect(await db.outbox.count()).toBe(0);
});
