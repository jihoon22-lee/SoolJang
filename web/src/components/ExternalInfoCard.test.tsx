import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LookupCandidate, SourceLookupResult } from "@/api/types";
import { ExternalInfoCard } from "@/components/ExternalInfoCard";
import { renderWithQuery, stubRoutes } from "@/testing";

function result(overrides: Partial<SourceLookupResult> = {}): SourceLookupResult {
  return {
    source_id: "s1",
    source_name: "데일리샷",
    cached: false,
    source_url: "https://dailyshot.co/item/123",
    fields: { price: "45,000원", rating: "4.2" },
    raw_excerpt: null,
    degraded: false,
    warning: null,
    fetched_at: "2026-08-13T00:00:00Z",
    matched_name: "글렌알라키 12년",
    match_score: 0.95,
    needs_confirmation: false,
    pinned: false,
    candidates: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<LookupCandidate> = {}): LookupCandidate {
  return {
    name: "글렌알라키 12년",
    url: "https://dailyshot.co/item/123",
    key: null,
    score: 0.6,
    ...overrides,
  };
}

describe("ExternalInfoCard", () => {
  it("오프라인이면 조회 버튼을 비활성화하고 안내한다", () => {
    renderWithQuery(<ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline />);

    expect(screen.getByRole("button", { name: "외부 정보 조회" })).toBeDisabled();
    expect(screen.getByText(/온라인일 때만/)).toBeInTheDocument();
  });

  it("웹에서 검색 링크가 제품명으로 브라우저 검색을 새 탭으로 연다", () => {
    renderWithQuery(<ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline />);

    const link = screen.getByRole("link", { name: "웹에서 검색" });
    expect(link).toHaveAttribute("href", expect.stringContaining("google.com/search"));
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("조회 버튼을 누르면 결과와 출처 링크를 보여준다", async () => {
    stubRoutes([{ match: "/products/p1/external-lookup", method: "POST", body: [result()] }]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText("데일리샷")).toBeInTheDocument();
    expect(await screen.findByText("45,000원")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "출처 보기" })).toHaveAttribute(
      "href",
      "https://dailyshot.co/item/123",
    );
  });

  it("일부만 확인됐으면 배지와 경고를 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [result({ degraded: true, warning: "평점을 찾지 못했습니다" })],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText("일부 정보만 확인됨")).toBeInTheDocument();
    expect(screen.getByText("평점을 찾지 못했습니다")).toBeInTheDocument();
  });

  it("등록된 소스가 없으면 안내를 보여준다", async () => {
    stubRoutes([{ match: "/products/p1/external-lookup", method: "POST", body: [] }]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText(/등록된 외부 소스가 없습니다/)).toBeInTheDocument();
  });

  it("조회가 실패하면 경고를 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        status: 500,
        body: {
          type: "https://sooljang.local/errors/internal",
          title: "서버 오류",
          status: 500,
          detail: "서버 오류",
        },
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  // --- 매칭 고정(Task 34 PR1, §7.4) ------------------------------------------

  it("확인이 필요하면 안내 문구와 후보 목록을 펼쳐서 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            needs_confirmation: true,
            candidates: [
              candidate({ name: "글렌알라키 12년", score: 0.6 }),
              candidate({
                name: "글렌알라키 10년",
                url: "https://dailyshot.co/item/456",
                score: 0.55,
              }),
            ],
          }),
        ],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText(/확인이 필요합니다/)).toBeInTheDocument();
    const summary = screen.getByText("후보 2개");
    const list = summary.closest("details");
    expect(list).not.toBeNull();
    expect(list?.open).toBe(true);
    expect(within(list as HTMLElement).getByText("글렌알라키 10년")).toBeInTheDocument();
  });

  it("후보의 이걸로 고정을 누르면 고정 요청 후 다시 조회한다", async () => {
    const { calls } = stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            needs_confirmation: true,
            candidates: [candidate()],
          }),
        ],
      },
      {
        match: "/products/p1/external-matches",
        method: "POST",
        status: 201,
        body: {
          id: "m1",
          source_id: "s1",
          product_id: "p1",
          external_url: "https://dailyshot.co/item/123",
          external_name: "글렌알라키 12년",
          external_key: null,
          confirmed_at: "2026-08-19T00:00:00Z",
        },
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));
    await screen.findByText(/확인이 필요합니다/);

    await userEvent.click(screen.getByRole("button", { name: "이걸로 고정" }));

    const pinCalls = calls.filter(
      (call) => call.url.includes("/external-matches") && call.method === "POST",
    );
    expect(pinCalls).toHaveLength(1);
    expect(pinCalls[0]?.body).toMatchObject({
      source_id: "s1",
      external_url: "https://dailyshot.co/item/123",
      external_name: "글렌알라키 12년",
    });
    // 고정 뒤 조회를 다시 실행한다 — lookup 라우트가 두 번(초기 + 재조회) 호출된다.
    const lookupCalls = calls.filter((call) => call.url.includes("/external-lookup"));
    expect(lookupCalls).toHaveLength(2);
  });

  it("고정돼 있으면 배지와 고정 해제 버튼을 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [result({ pinned: true })],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText("고정됨")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "고정 해제" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이걸로 고정" })).not.toBeInTheDocument();
  });

  it("오프라인이면 고정·해제 버튼이 비활성화된다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({ pinned: true }),
          result({
            source_id: "s2",
            source_name: "다른 소스",
            pinned: false,
            needs_confirmation: true,
            candidates: [candidate()],
          }),
        ],
      },
    ]);
    // `renderWithQuery` 는 매번 새 QueryClientProvider 로 감싸므로, 조회 결과를 유지한
    // 채 offline 만 바꾸려면 같은 client 로 직접 rerender 해야 한다.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));
    await screen.findByText("고정됨");
    expect(screen.getByRole("button", { name: "고정 해제" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "이걸로 고정" })).not.toBeDisabled();

    rerender(
      <QueryClientProvider client={client}>
        <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "고정 해제" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "이걸로 고정" })).toBeDisabled();
  });
});
