import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBottleTransitions, canTransition, undoBottleTransitions } from "@/sync/bottleActions";
import { activateDatabase, db } from "@/sync/db";

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
  await Promise.all([db.bottle.clear(), db.outbox.clear(), db.sku.clear(), db.purchase.clear()]);
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
  it("미개봉에서 증여한 병은 되돌리기와 개봉 취소로 원래 상태가 된다", async () => {
    await seedBottle("b1", "unopened");
    const result = await applyBottleTransitions(["b1"], "gift");

    await undoBottleTransitions(result.applied);

    expect((await db.bottle.get("b1"))?.status).toBe("unopened");
    const actions = (await db.outbox.toArray()).map((entry) => entry.action);
    expect(actions).toEqual(["gift", "reopen", "unopen"]);
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
