import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateDatabase, db } from "@/sync/db";
import { lastTastingContext, recordTasting, rememberTastingContext } from "@/sync/tastingActions";

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

beforeEach(async () => {
  await db.open();
  await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 500 }));
  await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 1 }));
});

afterEach(async () => {
  window.localStorage.clear();
  await Promise.all([
    db.bottle.clear(),
    db.outbox.clear(),
    db.sku.clear(),
    db.purchase.clear(),
    db.tasting_session.clear(),
  ]);
});

const base = { pouredMl: null, rating: null, userId: "u1" };

describe("recordTasting", () => {
  it("미개봉 병은 개봉되고, 앞선 날 시음이면 개봉일을 그날로 당긴다", async () => {
    await db.bottle.put(row({ id: "b1", purchase_id: "pu1", status: "unopened", opened_on: null }));

    await recordTasting({ ...base, bottleId: "b1", tastedOn: "2026-03-01", pouredMl: 100 });
    let bottle = await db.bottle.get("b1");
    expect(bottle?.status).toBe("open");
    expect(bottle?.remaining_ml).toBe(400);

    await recordTasting({ ...base, bottleId: "b1", tastedOn: "2026-02-20" });
    bottle = await db.bottle.get("b1");
    expect(bottle?.opened_on).toBe("2026-02-20");
  });

  it("마지막 잔이면 소진되고, 내보낸 병이나 잘못된 입력은 거부한다", async () => {
    await db.bottle.put(
      row({
        id: "b1",
        purchase_id: "pu1",
        status: "open",
        opened_on: "2026-01-01",
        remaining_ml: 50,
      }),
    );
    await db.bottle.put(row({ id: "b2", purchase_id: "pu1", status: "gifted" }));

    await expect(
      recordTasting({ ...base, bottleId: "b1", tastedOn: "2026-03-01", pouredMl: 60 }),
    ).rejects.toThrow("잔량이 부족합니다");
    await recordTasting({ ...base, bottleId: "b1", tastedOn: "2026-03-01", pouredMl: 50 });
    expect((await db.bottle.get("b1"))?.status).toBe("finished");

    await expect(
      recordTasting({ ...base, bottleId: "b2", tastedOn: "2026-03-01" }),
    ).rejects.toThrow("내보낸 병");
    await expect(
      recordTasting({ ...base, bottleId: "b1", tastedOn: "2026-03-01", rating: "4.3" }),
    ).rejects.toThrow("0.5 단위");
  });
});

describe("장소·동석자 기억", () => {
  it("직전 값을 계정별로 기억하고 다른 계정에는 보이지 않는다", async () => {
    await activateDatabase("u1");
    expect(lastTastingContext()).toEqual({ place: "", companions: "" });
    rememberTastingContext({ place: "집", companions: "친구" });
    expect(lastTastingContext()).toEqual({ place: "집", companions: "친구" });

    await activateDatabase("u2");
    expect(lastTastingContext()).toEqual({ place: "", companions: "" });
  });
});
