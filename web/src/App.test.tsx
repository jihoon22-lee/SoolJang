import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import type { CategoryTree, HealthStatus } from "@/api/types";
import { db } from "@/sync/db";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

const emptyTree: CategoryTree = { items: [], max_depth: 0, depth_limit: 8 };

const healthy: HealthStatus = {
  status: "ok",
  version: "0.1.0",
  environment: "test",
  database_connected: true,
  migration_revision: "0002_domain_model",
};

function stubAll() {
  return stubRoutes([
    ...authenticatedRoutes(),
    { match: "/health", body: healthy },
    { match: "/categories", body: emptyTree },
    { match: "/products", body: { items: [], next_cursor: null } },
  ]);
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.product.clear();
});

describe("App", () => {
  it("서비스 이름을 제목으로 표시한다", async () => {
    stubAll();
    renderWithQuery(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "술장" })).toBeInTheDocument();
  });

  it("키보드 사용자를 위한 본문 건너뛰기 링크를 제공한다", async () => {
    stubAll();
    renderWithQuery(<App />);

    const skip = await screen.findByRole("link", { name: "본문으로 건너뛰기" });
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("기본 화면은 술 목록이다", async () => {
    stubAll();
    renderWithQuery(<App />);

    expect(await screen.findByRole("heading", { name: /내 술/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "내 술" })).toHaveAttribute("aria-current", "page");
  });

  it("주종 관리로 전환한다", async () => {
    stubAll();
    renderWithQuery(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "주종 관리" }));

    expect(await screen.findByRole("heading", { name: "주종 관리" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "주종 관리" })).toHaveAttribute("aria-current", "page");
  });

  it("서비스 상태로 전환하면 마이그레이션 리비전을 보여준다", async () => {
    stubAll();
    renderWithQuery(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "서비스 상태" }));

    expect(await screen.findByText("0002_domain_model")).toBeInTheDocument();
  });

  it("DB 장애 시 degraded 로 표시한다", async () => {
    // 503 을 오류로 던지면 상태 화면 자체가 사라져 원인을 알 수 없다.
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/health",
        status: 503,
        body: {
          ...healthy,
          status: "degraded",
          database_connected: false,
          migration_revision: null,
        },
      },
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [], next_cursor: null } },
    ]);
    renderWithQuery(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "서비스 상태" }));

    expect(await screen.findByText("일부 구성 요소에 문제가 있습니다.")).toBeInTheDocument();
    expect(screen.getByText("연결 안 됨")).toBeInTheDocument();
  });

  it("내비게이션에 접근성 이름을 붙인다", async () => {
    stubAll();
    renderWithQuery(<App />);

    expect(await screen.findByRole("navigation", { name: "주요 화면" })).toBeInTheDocument();
  });

  it("병 관리·통계·가져오기 화면으로도 전환된다", async () => {
    stubAll();
    renderWithQuery(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "병 관리" }));
    expect(await screen.findByRole("heading", { name: "병 관리" })).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("link", { name: "통계" }));
    expect(await screen.findByRole("heading", { name: "통계" })).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("link", { name: "가져오기" }));
    expect(await screen.findByRole("heading", { name: "엑셀 기록 가져오기" })).toBeInTheDocument();
  });

  it("헤더에 동기화 상태 배지를 항상 보여준다", async () => {
    stubAll();
    renderWithQuery(<App />);

    expect(await screen.findByRole("button", { name: "최신 상태" })).toBeInTheDocument();

    // 탭을 바꿔도 배지는 그대로 보인다.
    await userEvent.click(await screen.findByRole("link", { name: "주종 관리" }));
    expect(screen.getByRole("button", { name: "최신 상태" })).toBeInTheDocument();
  });

  it("탭을 전환하면 URL 해시가 바뀐다", async () => {
    stubAll();
    renderWithQuery(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "통계" }));

    expect(window.location.hash).toBe("#stats");
  });

  it("제품을 선택하면 URL 에 제품 id 가 붙고, 뒤로가기로 목록에 돌아온다", async () => {
    stubAll();
    const now = "2026-01-01T00:00:00Z";
    await db.product.put({
      id: "p1",
      user_id: "u1",
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name: "글렌알라키 12년",
      category_id: null,
    });
    renderWithQuery(<App />);

    await userEvent.click(
      (await screen.findAllByRole("button", { name: "글렌알라키 12년" }))[0] as Element,
    );

    expect(await screen.findByRole("button", { name: "← 목록으로" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#products/p1");

    window.history.back();

    // 처음 로드 시점엔 해시가 비어 있었다("" 도 목록으로 해석된다) — 되돌아간 뒤 중요한 건
    // 실제로 목록 화면이 보이는지지 정확한 해시 문자열이 아니다.
    expect(await screen.findByRole("heading", { name: /내 술/ })).toBeInTheDocument();
    expect(window.location.hash).not.toContain("p1");
  });
});
