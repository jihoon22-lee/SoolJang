import { describe, expect, it } from "vitest";
import { parseHash, routeToHash } from "@/router";

describe("parseHash", () => {
  it("빈 해시는 제품 목록으로 해석한다", () => {
    expect(parseHash("")).toEqual({ view: "products" });
    expect(parseHash("#")).toEqual({ view: "products" });
  });

  it("단순 뷰 해시를 해석한다", () => {
    expect(parseHash("#stats")).toEqual({ view: "stats" });
    expect(parseHash("#categories")).toEqual({ view: "categories" });
    expect(parseHash("#vendors")).toEqual({ view: "vendors" });
  });

  it("모르는 뷰는 제품 목록으로 떨어진다", () => {
    expect(parseHash("#no-such-view")).toEqual({ view: "products" });
  });

  it("제품 상세 경로를 해석한다", () => {
    expect(parseHash("#products/abc-123")).toEqual({
      view: "products",
      productId: "abc-123",
      categoryId: undefined,
    });
  });

  it("주종 필터 쿼리를 해석한다", () => {
    expect(parseHash("#products?category=cat-1")).toEqual({
      view: "products",
      productId: undefined,
      categoryId: "cat-1",
    });
  });

  it("products 가 아닌 뷰에는 productId/categoryId 를 붙이지 않는다", () => {
    expect(parseHash("#categories/should-be-ignored")).toEqual({ view: "categories" });
  });

  it("선행 # 이 없어도 동작한다", () => {
    expect(parseHash("products/xyz")).toEqual({
      view: "products",
      productId: "xyz",
      categoryId: undefined,
    });
  });
});

describe("routeToHash", () => {
  it("단순 뷰를 해시로 만든다", () => {
    expect(routeToHash({ view: "stats" })).toBe("#stats");
  });

  it("제품 상세를 해시로 만든다", () => {
    expect(routeToHash({ view: "products", productId: "abc-123" })).toBe("#products/abc-123");
  });

  it("주종 필터를 해시로 만든다", () => {
    expect(routeToHash({ view: "products", categoryId: "cat-1" })).toBe("#products?category=cat-1");
  });

  it("productId 가 categoryId 보다 우선한다", () => {
    expect(routeToHash({ view: "products", productId: "p1", categoryId: "c1" })).toBe(
      "#products/p1",
    );
  });

  it("parseHash 의 역함수다(라운드트립)", () => {
    const cases = ["#products", "#stats", "#products/abc-123", "#products?category=cat-1"];
    for (const hash of cases) {
      expect(routeToHash(parseHash(hash))).toBe(hash);
    }
  });
});
