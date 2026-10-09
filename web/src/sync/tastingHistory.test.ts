import { beforeEach, describe, expect, it } from "vitest";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { getRecentTastings } from "@/sync/queries";
import {
  getCorrectionOptions,
  getLocalTasting,
  getLocalTastingHistory,
} from "@/sync/tastingHistory";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "history-owner",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  deleted_at: null,
  ...fields,
});
beforeEach(async () => {
  await activateDatabase("history-owner");
  for (const table of db.tables) await table.clear();
  await db.product.bulkPut([
    row("p20", { name: "같은 술", vintage: 2020 }),
    row("p21", { name: "같은 술", vintage: 2021 }),
  ]);
  await db.sku.bulkPut([
    row("s1", { product_id: "p20", volume_ml: 500 }),
    row("s2", { product_id: "p21", volume_ml: 750 }),
  ]);
  await db.vendor.put(row("v1", { name: "합성 매장" }));
  await db.purchase.bulkPut([
    row("q1", { sku_id: "s1", vendor_id: "v1", purchased_on: "2025-12-01", quantity: 1 }),
    row("q2", { sku_id: "s2", quantity: 1 }),
  ]);
  await db.bottle.bulkPut([
    row("b1", {
      purchase_id: "q1",
      revision: "r1",
      label_no: 1,
      status: "finished",
      remaining_ml: 0,
    }),
    row("b2", {
      purchase_id: "q2",
      revision: "r2",
      label_no: 1,
      status: "gifted",
      remaining_ml: null,
    }),
  ]);
  await db.tasting_session.bulkPut([
    row("t1", {
      sku_id: "s1",
      bottle_id: "b1",
      tasted_on: "2026-01-01",
      rating: "4",
      poured_ml: 30,
      note: "남길 메모",
    }),
    row("t2", {
      sku_id: "s1",
      bottle_id: null,
      tasted_on: "2026-01-02",
      rating: null,
      poured_ml: null,
    }),
    row("t3", {
      sku_id: "s1",
      bottle_id: "b1",
      tasted_on: "2026-01-02",
      rating: "5",
      poured_ml: 20,
    }),
    row("t4", {
      sku_id: "s2",
      bottle_id: "b2",
      tasted_on: "2026-01-03",
      rating: "3.5",
      poured_ml: 50,
    }),
  ]);
});
describe("기기에 저장된 시음 찾기", () => {
  it("같은 날 새로 기록한 시음이 홈의 최근 목록 앞에 오고 전체 이력과 같은 순서를 쓴다", async () => {
    await db.tasting_session.bulkPut(
      ["t5", "t6", "t7", "t8", "t9"].map((id) =>
        row(id, { sku_id: "s1", bottle_id: null, tasted_on: "2026-01-03" }),
      ),
    );
    expect((await getRecentTastings()).map((item) => item.id)).toEqual([
      "t9",
      "t8",
      "t7",
      "t6",
      "t5",
    ]);
  });

  it("홈 최근 목록은 삭제된 구매·병의 시음을 숨기고 독립 시음과 원본 행은 보존한다", async () => {
    await db.purchase.update("q1", { deleted_at: "2026-02-01T00:00:00Z" });
    expect((await getRecentTastings()).map((item) => item.id)).toEqual(["t4", "t2"]);
    await db.bottle.update("b2", { deleted_at: "2026-02-01T00:00:00Z" });
    expect((await getRecentTastings()).map((item) => item.id)).toEqual(["t2"]);
    expect(await db.tasting_session.count()).toBe(4);
    expect((await db.tasting_session.get("t1"))?.bottle_id).toBe("b1");
  });

  it("다른 사용자의 남은 행은 조회·요약·선택에 섞지 않고 원본도 지우지 않는다", async () => {
    await db.tasting_session.put(
      row("foreign-note", {
        user_id: "another-owner",
        sku_id: "s1",
        bottle_id: null,
        tasted_on: "2026-04-01",
        note: "다른 사용자 메모",
      }),
    );
    await db.product.put(row("foreign-product", { user_id: "another-owner", name: "다른 술" }));
    await db.sku.put(
      row("foreign-sku", {
        user_id: "another-owner",
        product_id: "foreign-product",
        volume_ml: 100,
      }),
    );
    expect((await getLocalTastingHistory({})).summary.session_count).toBe(4);
    expect(await getLocalTasting("foreign-note")).toBeNull();
    expect((await getCorrectionOptions()).skus).toHaveLength(2);
    expect(await db.tasting_session.get("foreign-note")).toBeDefined();
  });
  it("조회 중 계정 잠금과 역전 기간은 결과를 돌려주지 않는다", async () => {
    await expect(
      getLocalTastingHistory({ tasted_on_min: "2026-03-01", tasted_on_max: "2026-01-01" }),
    ).rejects.toThrow("시작일");
    const pending = getLocalTastingHistory({});
    lockDatabase();
    await expect(pending).rejects.toThrow("계정이 변경");
  });
  it("제품·규격·병·기간을 같은 기록에 적용하고 같은 범위의 요약을 계산한다", async () => {
    const data = await getLocalTastingHistory({
      product_id: "p20",
      sku_id: "s1",
      bottle_id: "b1",
      tasted_on_min: "2026-01-02",
      tasted_on_max: "2026-01-02",
    });
    expect(data.items.map((item) => item.id)).toEqual(["t3"]);
    expect(data.summary).toMatchObject({
      session_count: 1,
      rated_count: 1,
      total_poured_ml: 20,
      average_rating: "5.00",
      rating_change: "0",
    });
    expect(data.items[0]?.purchase?.vendor_name).toBe("합성 매장");
    expect((await getLocalTastingHistory({ product_id: "p20", sku_id: "s2" })).items).toEqual([]);
  });
  it("같은 날은 ID 내림차순이고 무평점은 평균에서 제외한다", async () => {
    const data = await getLocalTastingHistory({ product_id: "p20" });
    expect(data.items.map((item) => item.id)).toEqual(["t3", "t2", "t1"]);
    expect(data.summary).toMatchObject({
      session_count: 3,
      rated_count: 2,
      average_rating: "4.50",
      first_rating: "4",
      latest_rating: "5",
      rating_change: "1",
      total_poured_ml: 50,
    });
    expect(data.items[1]?.bottle).toBeNull();
    expect(data.items[1]?.purchase).toBeNull();
    expect((await getLocalTasting("t1"))?.note).toBe("남길 메모");
  });
  it("삭제된 부모·병·시음은 원본을 지우지 않고 조회에서 제외한다", async () => {
    await db.purchase.update("q1", { deleted_at: "2026-02-01T00:00:00Z" });
    await db.product.update("p21", { deleted_at: "2026-02-01T00:00:00Z" });
    expect((await getLocalTastingHistory({})).items.map((item) => item.id)).toEqual(["t2"]);
    expect(await getLocalTasting("t1")).toBeNull();
    await db.tasting_session.update("t2", { deleted_at: "2026-02-01T00:00:00Z" });
    expect((await getLocalTastingHistory({})).summary).toMatchObject({
      session_count: 0,
      average_rating: null,
      first_tasted_on: null,
    });
    expect(await db.tasting_session.count()).toBe(4);
  });
  it("정정 대상에는 다른 판본과 소진·증여·미기록 잔량도 포함한다", async () => {
    const options = await getCorrectionOptions();
    expect(options.bottles.map((option) => [option.context.vintage, option.bottle.status])).toEqual(
      [
        [2020, "finished"],
        [2021, "gifted"],
      ],
    );
    expect(options.bottles[1]?.bottle.remaining_ml).toBeNull();
    expect(options.skus.map((sku) => sku.volume_ml)).toEqual([500, 750]);
    await db.sku.update("s2", { deleted_at: "2026-02-01T00:00:00Z" });
    expect((await getCorrectionOptions()).bottles).toHaveLength(1);
  });
  it("50건 밖의 선택 기록도 직접 찾고 전체 로컬 내역을 반환한다", async () => {
    await db.tasting_session.bulkPut(
      Array.from({ length: 55 }, (_, i) =>
        row(`new-${i}`, { sku_id: "s1", bottle_id: "b1", tasted_on: "2026-03-01" }),
      ),
    );
    expect((await getLocalTastingHistory({ product_id: "p20" })).items).toHaveLength(58);
    expect((await getLocalTasting("t1"))?.id).toBe("t1");
    expect(await getLocalTasting("missing")).toBeNull();
  });
});
