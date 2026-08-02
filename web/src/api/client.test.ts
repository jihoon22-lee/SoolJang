import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_PREFIX,
  ApiError,
  attachmentsApi,
  categoriesApi,
  fetchHealth,
  productsApi,
} from "@/api/client";
import type { HealthStatus, ProblemDetail } from "@/api/types";

const healthy: HealthStatus = {
  status: "ok",
  version: "0.1.0",
  environment: "test",
  database_connected: true,
  migration_revision: "0002_domain_model",
};

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** noUncheckedIndexedAccess 를 켜 두었으므로 호출 인자를 꺼낼 때 존재를 확인한다. */
function firstCall(spy: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("fetch 가 호출되지 않았습니다");
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

describe("fetchHealth", () => {
  it("정상 응답을 파싱한다", async () => {
    const spy = stubFetch(200, healthy);

    await expect(fetchHealth()).resolves.toEqual(healthy);
    expect(spy).toHaveBeenCalledWith(`${API_PREFIX}/health`, expect.anything());
  });

  it("503 은 오류로 던지지 않고 degraded 상태로 반환한다", async () => {
    // 상태 표시 화면 자체가 사라지면 원인을 알 수 없다.
    const degraded: HealthStatus = { ...healthy, status: "degraded", database_connected: false };
    stubFetch(503, degraded);

    await expect(fetchHealth()).resolves.toEqual(degraded);
  });

  it("그 밖의 실패는 ApiError 로 던진다", async () => {
    stubFetch(500, { detail: "boom" });

    await expect(fetchHealth()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("에러 변환", () => {
  const problem: ProblemDetail = {
    type: "https://sooljang.local/errors/validation",
    title: "요청 값이 올바르지 않습니다",
    status: 422,
    detail: "입력값을 확인하세요",
    instance: "/api/v1/products",
    errors: [
      { field: "personal_rating", code: "less_than_equal", message: "6 이하여야 합니다" },
      { field: "name", code: "too_short", message: "필수입니다" },
    ],
  };

  it("Problem Details 를 보존해 필드 오류를 꺼낼 수 있다", async () => {
    stubFetch(422, problem);

    const error = await productsApi.create({ name: "" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.message).toBe("입력값을 확인하세요");
    expect(apiError.fieldErrors).toHaveLength(2);
    expect(apiError.errorFor("personal_rating")).toBe("6 이하여야 합니다");
    expect(apiError.errorFor("없는필드")).toBeUndefined();
  });

  it("Problem Details 가 아니면 상태 코드로 메시지를 만든다", async () => {
    stubFetch(500, { unexpected: true });

    const error = (await categoriesApi.tree().catch((caught: unknown) => caught)) as ApiError;

    expect(error.problem).toBeNull();
    expect(error.message).toContain("500");
    expect(error.fieldErrors).toEqual([]);
  });

  it("본문이 JSON 이 아니어도 오류로 처리한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );

    await expect(categoriesApi.tree()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("요청 조립", () => {
  it("빈 값과 undefined 는 쿼리에서 제외한다", async () => {
    const spy = stubFetch(200, { items: [], next_cursor: null });

    await productsApi.list({ q: "", abv_min: "40", sort: "name", cursor: null });

    const { url } = firstCall(spy);
    expect(url).toContain("abv_min=40");
    expect(url).toContain("sort=name");
    expect(url).not.toContain("q=");
    expect(url).not.toContain("cursor=");
  });

  it("한글 검색어를 인코딩한다", async () => {
    const spy = stubFetch(200, { items: [], next_cursor: null });

    await productsApi.list({ q: "캐스크" });

    const { url } = firstCall(spy);
    expect(url).toContain(encodeURIComponent("캐스크"));
  });

  it("204 응답은 본문 없이 완료된다", async () => {
    stubFetch(204, null);

    await expect(productsApi.remove("abc")).resolves.toBeUndefined();
  });

  it("본문이 있는 요청에 Content-Type 을 붙인다", async () => {
    const spy = stubFetch(200, {});

    await categoriesApi.create({ name: "새 주종" });

    const { init } = firstCall(spy);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("삭제 전략을 쿼리로 전달한다", async () => {
    const spy = stubFetch(200, { items: [], max_depth: 0, depth_limit: 8 });

    await categoriesApi.remove("cat-1", "reassign", "cat-2");

    const { url } = firstCall(spy);
    expect(url).toContain("strategy=reassign");
    expect(url).toContain("target_id=cat-2");
  });
});

describe("attachmentsApi.create", () => {
  const file = new File(["x"], "photo.png", { type: "image/png" });

  it("product_id 만 지정하면 그 필드만 함께 보낸다", async () => {
    const spy = stubFetch(201, { id: "a1" });

    await attachmentsApi.create(file, { kind: "label", product_id: "p1" });

    const { init } = firstCall(spy);
    const form = init.body as FormData;
    expect(form.get("kind")).toBe("label");
    expect(form.get("product_id")).toBe("p1");
    expect(form.get("bottle_id")).toBeNull();
    expect(form.get("tasting_session_id")).toBeNull();
  });

  it("bottle_id 만 지정하면 그 필드만 함께 보낸다", async () => {
    const spy = stubFetch(201, { id: "a2" });

    await attachmentsApi.create(file, { kind: "bottle", bottle_id: "b1" });

    const { init } = firstCall(spy);
    const form = init.body as FormData;
    expect(form.get("bottle_id")).toBe("b1");
    expect(form.get("product_id")).toBeNull();
  });

  it("tasting_session_id 만 지정하면 그 필드만 함께 보낸다", async () => {
    const spy = stubFetch(201, { id: "a3" });

    await attachmentsApi.create(file, { kind: "tasting", tasting_session_id: "t1" });

    const { init } = firstCall(spy);
    const form = init.body as FormData;
    expect(form.get("tasting_session_id")).toBe("t1");
    expect(form.get("bottle_id")).toBeNull();
  });
});
