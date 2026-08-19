import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SourceLookupResult } from "@/api/types";
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
    matched_name: null,
    match_score: null,
    needs_confirmation: false,
    pinned: false,
    candidates: [],
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
  it("확신이 낮으면 확인 문구와 후보 목록을 펼쳐 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            matched_name: "글렌알라키 12년 셰리",
            match_score: 0.62,
            needs_confirmation: true,
            candidates: [
              { name: "글렌알라키 12년 셰리", url: "https://d.co/1", key: "1", score: 0.62 },
              { name: "글렌알라키 10년 CS", url: "https://d.co/2", key: "2", score: 0.55 },
            ],
          }),
        ],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText(/이 술이 맞는지 확인해 주세요/)).toBeInTheDocument();
    expect(screen.getByText("글렌알라키 10년 CS")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "이걸로 고정" })).toHaveLength(2);
  });

  it("후보를 고정하면 고정 요청을 보내고 다시 조회한다", async () => {
    const { calls } = stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            needs_confirmation: true,
            candidates: [
              { name: "글렌알라키 10년 CS", url: "https://d.co/2", key: "2", score: 0.55 },
            ],
          }),
        ],
      },
      { match: "/products/p1/external-matches", method: "POST", body: {} },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));
    await userEvent.click(await screen.findByRole("button", { name: "이걸로 고정" }));

    const pinCall = await vi.waitFor(() => {
      const found = calls.find((call) => call.url.includes("/external-matches"));
      expect(found).toBeDefined();
      return found;
    });
    expect(pinCall?.body).toMatchObject({
      source_id: "s1",
      external_url: "https://d.co/2",
      external_name: "글렌알라키 10년 CS",
      external_key: "2",
    });
  });

  it("고정된 결과면 고정 배지와 해제 버튼을 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [result({ pinned: true, matched_name: "글렌알라키 10년 CS", match_score: 1 })],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText("고정됨")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "고정 해제" })).toBeEnabled();
  });

  it("오프라인이면 고정 버튼을 비활성화한다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            needs_confirmation: true,
            candidates: [
              { name: "글렌알라키 10년 CS", url: "https://d.co/2", key: "2", score: 0.55 },
            ],
          }),
        ],
      },
    ]);
    // 조회 결과를 받은 뒤 오프라인으로 바뀐 상태를 흉내 낸다.
    const { rerender } = renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));
    await screen.findByRole("button", { name: "이걸로 고정" });

    rerender(<ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline />);

    expect(screen.getByRole("button", { name: "이걸로 고정" })).toBeDisabled();
  });
});
