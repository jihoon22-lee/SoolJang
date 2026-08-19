import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SourcesPage } from "@/pages/SourcesPage";
import { db } from "@/sync/db";
import { renderWithQuery, stubRoutes } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

function categoryRow(overrides: Record<string, unknown>) {
  return {
    id: "cat-1",
    user_id: "u1",
    parent_id: null,
    name: "위스키",
    sort_order: 1,
    is_seeded: false,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

const ADAPTER_SPEC = {
  search: {
    url_template: "https://example.com/search?q={query}",
    item: ".product-card",
    fields: {
      name: { selector: ".title", attr: "text" },
      url: { selector: "a", attr: "href", absolute: true },
    },
  },
  detail: { fields: { price: { selector: ".price", attr: "text" } } },
};

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "src-1",
    name: "데일리샷",
    base_url: "https://example.com",
    adapter_spec: ADAPTER_SPEC,
    category_id: null,
    priority: 0,
    is_active: true,
    rate_limit_per_min: 6,
    ttl_hours: 24,
    note: null,
    ...overrides,
  };
}

//: `.includes()` 매칭이라 "/external-sources" 가 "/external-sources/health" 의 부분
//: 문자열이기도 하다 — 이 스텁을 먼저 둬야 health 요청이 목록 스텁에 가로채이지 않는다.
function emptyHealthRoute() {
  return { match: "/external-sources/health", method: "GET", body: [] };
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  await db.category.clear();
  vi.unstubAllGlobals();
});

describe("SourcesPage", () => {
  it("소스가 없으면 안내한다", async () => {
    stubRoutes([emptyHealthRoute(), { match: "/external-sources", method: "GET", body: [] }]);

    renderWithQuery(<SourcesPage />);

    expect(await screen.findByText("등록된 외부 소스가 없습니다.")).toBeInTheDocument();
  });

  it("등록된 소스를 목록으로 보여준다", async () => {
    stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [sourceRow()] },
    ]);

    renderWithQuery(<SourcesPage />);

    expect(await screen.findByText("데일리샷")).toBeInTheDocument();
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    expect(screen.getByText("활성")).toBeInTheDocument();
    const row = screen.getByText("데일리샷").closest("li");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("전체 주종");
  });

  it("헬스 이력이 없으면 미확인 배지를 보여준다", async () => {
    stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [sourceRow()] },
    ]);

    renderWithQuery(<SourcesPage />);

    const row = (await screen.findByText("데일리샷")).closest("li");
    expect(row).toHaveTextContent("미확인");
  });

  it("헬스가 failing 이면 실패 배지와 경고를 보여준다", async () => {
    stubRoutes([
      {
        match: "/external-sources/health",
        method: "GET",
        body: [
          {
            source_id: "src-1",
            source_name: "데일리샷",
            status: "failing",
            last_success_at: null,
            consecutive_failures: 3,
            last_warning: "검색 결과에서 후보를 찾지 못했습니다",
          },
        ],
      },
      { match: "/external-sources", method: "GET", body: [sourceRow()] },
    ]);

    renderWithQuery(<SourcesPage />);

    const row = (await screen.findByText("데일리샷")).closest("li");
    expect(row).toHaveTextContent("실패");
    expect(row).toHaveTextContent("검색 결과에서 후보를 찾지 못했습니다");
  });

  it("테스트 조회를 실행하면 결과를 인라인으로 보여준다", async () => {
    const { calls } = stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [sourceRow()] },
      {
        match: "/external-sources/src-1/probe",
        method: "POST",
        body: {
          ok: true,
          degraded: false,
          warning: null,
          matched_name: "데일리샷 글렌피딕 12년",
          match_score: 0.9,
        },
      },
    ]);

    renderWithQuery(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "테스트 조회" }));
    await userEvent.click(screen.getByRole("button", { name: "실행" }));

    expect(await screen.findByText(/성공 — 매칭: 데일리샷 글렌피딕 12년/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/probe"))).toBe(true);
  });

  it("새 소스를 등록하면 입력한 값으로 요청을 보낸다", async () => {
    const { calls } = stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [] },
      { match: "/external-sources", method: "POST", status: 201, body: sourceRow() },
    ]);

    renderWithQuery(<SourcesPage />);
    await screen.findByText("등록된 외부 소스가 없습니다.");

    await userEvent.type(screen.getByLabelText("이름"), "데일리샷");
    await userEvent.type(screen.getByLabelText("사이트 주소"), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.method === "POST" && call.url.includes("/external-sources"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({
        name: "데일리샷",
        base_url: "https://example.com",
      });
    });
  });

  it("adapter_spec 이 잘못된 JSON이면 요청을 보내지 않고 오류를 보여준다", async () => {
    const { calls } = stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [] },
    ]);

    renderWithQuery(<SourcesPage />);
    await screen.findByText("등록된 외부 소스가 없습니다.");

    await userEvent.type(screen.getByLabelText("이름"), "데일리샷");
    await userEvent.type(screen.getByLabelText("사이트 주소"), "https://example.com");
    const specField = screen.getByLabelText(/adapter_spec/);
    await userEvent.clear(specField);
    await userEvent.type(specField, "이것은 JSON이 아닙니다");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("올바른 JSON");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("수정을 누르면 현재 값이 채워진 폼이 열린다", async () => {
    stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [sourceRow()] },
    ]);

    renderWithQuery(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "수정" }));

    expect(screen.getByLabelText("이름")).toHaveValue("데일리샷");
    expect(screen.getByLabelText("사이트 주소")).toHaveValue("https://example.com");
    expect(screen.getByRole("button", { name: "저장" })).toBeInTheDocument();
  });

  it("적용 주종 select 에 카테고리 목록이 채워진다", async () => {
    await db.category.put(categoryRow({}));
    stubRoutes([emptyHealthRoute(), { match: "/external-sources", method: "GET", body: [] }]);

    renderWithQuery(<SourcesPage />);
    await screen.findByText("등록된 외부 소스가 없습니다.");

    expect(await screen.findByRole("option", { name: "위스키" })).toBeInTheDocument();
  });

  it("삭제를 누르면 삭제 요청을 보낸다", async () => {
    const { calls } = stubRoutes([
      emptyHealthRoute(),
      { match: "/external-sources", method: "GET", body: [sourceRow()] },
      { match: "/external-sources", method: "DELETE", status: 204, body: null },
    ]);

    renderWithQuery(<SourcesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.includes("src-1"))).toBe(
        true,
      );
    });
  });
});
