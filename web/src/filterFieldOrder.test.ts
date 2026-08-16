import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FILTER_FIELD_ORDER,
  getFilterFieldOrder,
  moveFieldDown,
  moveFieldUp,
  setFilterFieldOrder,
} from "@/filterFieldOrder";

afterEach(() => {
  window.localStorage.clear();
});

describe("filterFieldOrder", () => {
  it("기록이 없으면 기본 순서를 돌려준다", () => {
    expect(getFilterFieldOrder()).toEqual(DEFAULT_FILTER_FIELD_ORDER);
  });

  it("저장한 순서를 그대로 돌려준다", () => {
    const custom = [
      "vendor",
      "q",
      "category",
      "abv",
      "rating",
      "stock",
      "sort",
      "stockFirst",
      "country",
      "vintage",
      "variety",
      "price100ml",
      "purchasedOn",
    ] as const;
    setFilterFieldOrder([...custom]);

    expect(getFilterFieldOrder()).toEqual([...custom]);
  });

  it("모르는 id 는 걸러내고, 저장에 없던 아는 id 는 끝에 붙인다", () => {
    // 옛 저장값에 더는 없는 필드("legacy")가 섞여 있고, 새로 생긴 필드("purchasedOn")가
    // 빠져 있는 상황을 흉내낸다 — 스키마가 바뀌어도 조용히 사라지는 필드가 없어야 한다.
    window.localStorage.setItem(
      "sooljang:products-filter-order",
      JSON.stringify(["vendor", "legacy", "q"]),
    );

    const order = getFilterFieldOrder();

    expect(order.slice(0, 2)).toEqual(["vendor", "q"]);
    expect(order).not.toContain("legacy");
    expect(order).toContain("purchasedOn");
    expect(order).toHaveLength(DEFAULT_FILTER_FIELD_ORDER.length);
  });

  it("moveFieldUp 은 인접 항목과 자리를 바꾸고, 맨 앞이면 그대로 둔다", () => {
    const order = ["a", "b", "c"] as const;

    expect(moveFieldUp([...order], "b")).toEqual(["b", "a", "c"]);
    expect(moveFieldUp([...order], "a")).toEqual(["a", "b", "c"]);
  });

  it("moveFieldDown 은 인접 항목과 자리를 바꾸고, 맨 끝이면 그대로 둔다", () => {
    const order = ["a", "b", "c"] as const;

    expect(moveFieldDown([...order], "b")).toEqual(["a", "c", "b"]);
    expect(moveFieldDown([...order], "c")).toEqual(["a", "b", "c"]);
  });
});
