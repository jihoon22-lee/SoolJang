import { beforeEach, expect, it, vi } from "vitest";
import { readProductListState, saveProductListState } from "@/productListState";

beforeEach(() => sessionStorage.clear());
it("계정별 필터·정렬·더 보기 범위·스크롤을 한 번에 복원한다", () => {
  const state = {
    filters: { q: "합성 술", sort: "avg_paid_price" as const, order: "desc" as const },
    visibleCount: 90,
    scrollY: 1234,
  };
  saveProductListState("owner-a", state);
  expect(readProductListState("owner-a")).toEqual(state);
  expect(readProductListState("owner-b")).toBeNull();
});
it("손상됐거나 사용할 수 없는 저장소는 기본 화면을 막지 않는다", () => {
  sessionStorage.setItem("sooljang:product-list:u", "{");
  expect(readProductListState("u")).toBeNull();
  sessionStorage.setItem(
    "sooljang:product-list:u",
    JSON.stringify({ filters: {}, visibleCount: -1, scrollY: 0 }),
  );
  expect(readProductListState("u")).toBeNull();
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(() =>
    saveProductListState("u", { filters: {}, visibleCount: 30, scrollY: 0 }),
  ).not.toThrow();
  spy.mockRestore();
});
