import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
    ...overrides,
  };
}

describe("ExternalInfoCard", () => {
  it("오프라인이면 조회 버튼을 비활성화하고 안내한다", () => {
    renderWithQuery(<ExternalInfoCard productId="p1" offline />);

    expect(screen.getByRole("button", { name: "외부 정보 조회" })).toBeDisabled();
    expect(screen.getByText(/온라인일 때만/)).toBeInTheDocument();
  });

  it("조회 버튼을 누르면 결과와 출처 링크를 보여준다", async () => {
    stubRoutes([{ match: "/products/p1/external-lookup", method: "POST", body: [result()] }]);
    renderWithQuery(<ExternalInfoCard productId="p1" offline={false} />);

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
    renderWithQuery(<ExternalInfoCard productId="p1" offline={false} />);

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByText("일부 정보만 확인됨")).toBeInTheDocument();
    expect(screen.getByText("평점을 찾지 못했습니다")).toBeInTheDocument();
  });

  it("등록된 소스가 없으면 안내를 보여준다", async () => {
    stubRoutes([{ match: "/products/p1/external-lookup", method: "POST", body: [] }]);
    renderWithQuery(<ExternalInfoCard productId="p1" offline={false} />);

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
    renderWithQuery(<ExternalInfoCard productId="p1" offline={false} />);

    await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
