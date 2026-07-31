import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { HealthStatus } from "@/api/client";

const healthy: HealthStatus = {
  status: "ok",
  version: "0.1.0",
  environment: "test",
  database_connected: true,
  migration_revision: "0001_enable_pg_trgm",
};

function renderApp(node: ReactNode = <App />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("서비스 이름을 제목으로 표시한다", () => {
    stubFetch(200, healthy);
    renderApp();

    expect(screen.getByRole("heading", { level: 1, name: "술장" })).toBeInTheDocument();
  });

  it("조회 중에는 진행 상태를 알린다", () => {
    stubFetch(200, healthy);
    renderApp();

    expect(screen.getByRole("status")).toHaveTextContent("서비스 상태를 확인하고 있습니다");
  });

  it("정상 상태와 마이그레이션 리비전을 표시한다", async () => {
    stubFetch(200, healthy);
    renderApp();

    expect(await screen.findByText("정상 동작 중입니다.")).toBeInTheDocument();
    expect(screen.getByText("0001_enable_pg_trgm")).toBeInTheDocument();
    expect(screen.getByText("연결됨")).toBeInTheDocument();
  });

  it("DB 장애 시 degraded 로 표시하고 마이그레이션 없음을 알린다", async () => {
    stubFetch(503, {
      ...healthy,
      status: "degraded",
      database_connected: false,
      migration_revision: null,
    });
    renderApp();

    expect(await screen.findByText("일부 구성 요소에 문제가 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("연결 안 됨")).toBeInTheDocument();
    expect(screen.getByText("적용된 마이그레이션 없음")).toBeInTheDocument();
  });

  it("요청이 실패하면 alert 역할로 오류를 알린다", async () => {
    stubFetch(500, {});
    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("백엔드에 연결할 수 없습니다");
  });

  it("네트워크 오류 메시지도 표시한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });
});
