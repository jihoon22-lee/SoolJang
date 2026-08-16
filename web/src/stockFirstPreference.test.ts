import { afterEach, describe, expect, it } from "vitest";
import { getStockFirstPreference, setStockFirstPreference } from "@/stockFirstPreference";

afterEach(() => {
  window.localStorage.clear();
});

describe("stockFirstPreference", () => {
  it("기록이 없으면 기본값(켬)을 돌려준다", () => {
    expect(getStockFirstPreference()).toBe(true);
  });

  it("저장한 값을 돌려준다", () => {
    setStockFirstPreference(false);
    expect(getStockFirstPreference()).toBe(false);

    setStockFirstPreference(true);
    expect(getStockFirstPreference()).toBe(true);
  });
});
