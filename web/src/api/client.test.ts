import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PREFIX, ApiError, fetchHealth, type HealthStatus } from "@/api/client";

const healthy: HealthStatus = {
  status: "ok",
  version: "0.1.0",
  environment: "test",
  database_connected: true,
  migration_revision: "0001_enable_pg_trgm",
};

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
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

describe("fetchHealth", () => {
  it("정상 응답을 파싱한다", async () => {
    const spy = mockFetch(200, healthy);

    await expect(fetchHealth()).resolves.toEqual(healthy);
    expect(spy).toHaveBeenCalledWith(`${API_PREFIX}/health`, expect.anything());
  });

  it("503 은 오류로 던지지 않고 degraded 상태로 반환한다", async () => {
    // 상태 표시 화면이 사라지면 원인을 알 수 없으므로 본문을 그대로 쓴다.
    const degraded: HealthStatus = {
      ...healthy,
      status: "degraded",
      database_connected: false,
      migration_revision: null,
    };
    mockFetch(503, degraded);

    await expect(fetchHealth()).resolves.toEqual(degraded);
  });

  it("그 밖의 실패 상태는 ApiError 로 던진다", async () => {
    mockFetch(500, { detail: "boom" });

    await expect(fetchHealth()).rejects.toBeInstanceOf(ApiError);
  });

  it("ApiError 는 HTTP 상태를 보존한다", async () => {
    mockFetch(502, {});

    await expect(fetchHealth()).rejects.toMatchObject({ status: 502, name: "ApiError" });
  });

  it("AbortSignal 을 전달한다", async () => {
    const spy = mockFetch(200, healthy);
    const controller = new AbortController();

    await fetchHealth(controller.signal);

    expect(spy).toHaveBeenCalledWith(
      `${API_PREFIX}/health`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
