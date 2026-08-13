import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthPanel } from "@/components/HealthPanel";
import { renderWithQuery, stubRoutes } from "@/testing";

const OK_HEALTH = {
  status: "ok",
  version: "1.2.0",
  environment: "production",
  database_connected: true,
  migration_revision: "757982c7b323",
};

describe("HealthPanel", () => {
  it("정상 상태와 버전·DB 연결을 보여준다", async () => {
    stubRoutes([{ match: "/health", method: "GET", body: OK_HEALTH }]);
    renderWithQuery(<HealthPanel />);

    expect(await screen.findByText("정상 동작 중입니다.")).toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
    expect(screen.getByText("연결됨")).toBeInTheDocument();
  });

  it("degraded 상태와 DB 연결 실패를 보여준다", async () => {
    stubRoutes([
      {
        match: "/health",
        method: "GET",
        status: 503,
        body: {
          ...OK_HEALTH,
          status: "degraded",
          database_connected: false,
          migration_revision: null,
        },
      },
    ]);
    renderWithQuery(<HealthPanel />);

    expect(await screen.findByText("일부 구성 요소에 문제가 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("degraded")).toBeInTheDocument();
    expect(screen.getByText("연결 안 됨")).toBeInTheDocument();
    expect(screen.getByText("적용된 마이그레이션 없음")).toBeInTheDocument();
  });

  it("백엔드에 연결할 수 없으면 경고를 보여준다", async () => {
    stubRoutes([{ match: "/health", method: "GET", status: 500, body: { detail: "boom" } }]);
    renderWithQuery(<HealthPanel />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
