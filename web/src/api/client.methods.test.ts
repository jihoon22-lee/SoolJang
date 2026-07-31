import { afterEach, describe, expect, it, vi } from "vitest";
import { categoriesApi, productsApi, purchasesApi, vendorsApi } from "@/api/client";
import { stubRoutes } from "@/testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("productsApi", () => {
  it("수정은 PATCH 로 보낸다", async () => {
    const { calls } = stubRoutes([{ match: "/products/p1", method: "PATCH", body: {} }]);

    await productsApi.update("p1", { personal_rating: "5.5" });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ personal_rating: "5.5" });
  });

  it("규격을 추가한다", async () => {
    const { calls } = stubRoutes([
      { match: "/products/p1/skus", method: "POST", status: 201, body: {} },
    ]);

    await productsApi.addSku("p1", 1000);

    expect(calls[0]?.body).toEqual({ volume_ml: 1000 });
  });

  it("상세를 조회한다", async () => {
    const { calls } = stubRoutes([{ match: "/products/p1", body: { id: "p1" } }]);

    await productsApi.get("p1");

    expect(calls[0]?.url).toContain("/products/p1");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("purchasesApi", () => {
  it("구매 건 목록을 제품으로 필터한다", async () => {
    const { calls } = stubRoutes([{ match: "/purchases", body: [] }]);

    await purchasesApi.list({ product_id: "p1" });

    expect(calls[0]?.url).toContain("product_id=p1");
  });

  it("병 목록을 조회한다", async () => {
    const { calls } = stubRoutes([{ match: "/purchases/pu1/bottles", body: [] }]);

    await purchasesApi.bottles("pu1");

    expect(calls[0]?.url).toContain("/purchases/pu1/bottles");
  });

  it("구매 건을 분할한다", async () => {
    // 레거시 임포트가 만든 합성 구매 건을 실제 구매처별로 쪼개는 경로다.
    const { calls } = stubRoutes([{ match: "/purchases/pu1:split", method: "POST", body: [] }]);

    await purchasesApi.split("pu1", [{ quantity: 2 }, { quantity: 1, vendor_id: "v2" }]);

    expect(calls[0]?.body).toEqual({
      parts: [{ quantity: 2 }, { quantity: 1, vendor_id: "v2" }],
    });
  });

  it("구매 건을 삭제한다", async () => {
    const { calls } = stubRoutes([
      { match: "/purchases/pu1", method: "DELETE", status: 204, body: null },
    ]);

    await expect(purchasesApi.remove("pu1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });
});

describe("vendorsApi", () => {
  it("구매처를 만든다", async () => {
    const { calls } = stubRoutes([
      { match: "/vendors", method: "POST", status: 201, body: { id: "v1" } },
    ]);

    await vendorsApi.create({ name: "가상마트", kind: "mart" });

    expect(calls[0]?.body).toEqual({ name: "가상마트", kind: "mart" });
  });
});

describe("categoriesApi", () => {
  it("이동은 새 부모를 본문으로 보낸다", async () => {
    const { calls } = stubRoutes([{ match: "/categories/c1:reparent", method: "POST", body: {} }]);

    await categoriesApi.reparent("c1", null);

    expect(calls[0]?.body).toEqual({ new_parent_id: null });
  });

  it("순서 변경은 목록을 한 번에 보낸다", async () => {
    const { calls } = stubRoutes([{ match: "/categories:reorder", method: "POST", body: {} }]);

    await categoriesApi.reorder([{ id: "a", sort_order: 1 }]);

    expect(calls[0]?.body).toEqual({ items: [{ id: "a", sort_order: 1 }] });
  });

  it("병합은 대상 id 를 보낸다", async () => {
    const { calls } = stubRoutes([{ match: "/categories/c1:merge", method: "POST", body: {} }]);

    await categoriesApi.merge("c1", "c2");

    expect(calls[0]?.body).toEqual({ target_id: "c2" });
  });
});
