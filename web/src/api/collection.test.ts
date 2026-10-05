import { afterEach, describe, expect, it, vi } from "vitest";
import { collectionApi, MOVE_BATCH_LIMIT } from "@/api/collection";
import { stubRoutes } from "@/testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectionApi.moveMany", () => {
  it("서버 상한보다 많은 병은 나눠 보내고 결과를 합친다", async () => {
    // 재고 1,000병을 "모두 선택"해 옮기면 한 요청에 담을 수 없다(서버 최대 500).
    const { calls } = stubRoutes([
      { match: "/collection/bottles:move", method: "PUT", body: { moved: 500, unchanged: 0 } },
    ]);
    const ids = Array.from({ length: MOVE_BATCH_LIMIT * 2 + 1 }, (_, index) => `b${index}`);

    const result = await collectionApi.moveMany(ids, "l1");

    expect(calls).toHaveLength(3);
    const sizes = calls.map((call) => (call.body as { bottle_ids: string[] }).bottle_ids.length);
    expect(sizes).toEqual([MOVE_BATCH_LIMIT, MOVE_BATCH_LIMIT, 1]);
    expect(calls.flatMap((call) => (call.body as { bottle_ids: string[] }).bottle_ids)).toEqual(
      ids,
    );
    expect(result).toEqual({ moved: 1500, unchanged: 0 });
  });
});
