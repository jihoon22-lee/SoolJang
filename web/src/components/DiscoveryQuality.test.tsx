import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { connectionsApi, externalSourcesApi } from "@/api/client";
import { type DiscoveryDocument, discoveryApi } from "@/api/discovery";
import { renderWithQuery } from "@/testing";
import { DiscoveryPanel } from "./DiscoveryPanel";

afterEach(() => vi.restoreAllMocks());
function setup() {
  localStorage.clear();
  vi.spyOn(connectionsApi, "list").mockResolvedValue([
    { id: "brave", name: "검색", is_active: true, provider_kind: "brave" },
  ] as never);
  vi.spyOn(externalSourcesApi, "list").mockResolvedValue([]);
  const make = (kind: DiscoveryDocument["kind"], title: string) => ({
    id: title,
    kind,
    title,
    url: `https://example.com/${kind}`,
    domain: "example.com",
    excerpt: "개인 저장 금지 원문",
    fetched_at: "2026-10-11",
    published_at: null,
    discovered_by: ["brave"],
    evidence: "search_excerpt" as const,
    rating: null,
    rating_scale: null,
    rating_count: null,
  });
  vi.spyOn(discoveryApi, "search").mockResolvedValue({
    connection_id: "brave",
    outcome: "success",
    requests: 1,
    warning: null,
    documents: [
      make("info", "확인된 제품 이름"),
      make("review", "술 시음기"),
      make("service_review", "택배 후기"),
      make("offer", "제품 판매"),
      make("seller_note", "판매자 설명"),
    ],
  });
  vi.spyOn(discoveryApi, "saveInterest").mockResolvedValue({
    name: "사용자가 확인한 제품",
  } as never);
}
it("목적별 자료를 분리하고 선택 제품명과 출처만 확인해서 관심에 저장한다", async () => {
  setup();
  renderWithQuery(<DiscoveryPanel initialName="모호한 검색어" />);
  await userEvent.click(await screen.findByLabelText("검색 · 검색"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  const heading = await screen.findByRole("heading", { name: "확인된 제품 이름" });
  expect(screen.queryByRole("heading", { name: "술 시음기" })).not.toBeInTheDocument();
  await userEvent.click(
    within(heading.closest("article") as HTMLElement).getByRole("button", {
      name: "이 자료를 관심에 연결",
    }),
  );
  const input = screen.getByLabelText("저장할 제품명");
  fireEvent.change(input, { target: { value: "사용자가 확인한 제품" } });
  expect(screen.getByRole("button", { name: "관심에 저장" })).toBeDisabled();
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  await waitFor(() => expect(discoveryApi.saveInterest).toHaveBeenCalled());
  expect(vi.mocked(discoveryApi.saveInterest).mock.calls[0]).toEqual([
    expect.objectContaining({ name: "사용자가 확인한 제품" }),
    {},
    expect.any(String),
    ["https://example.com/info"],
  ]);
  expect(JSON.stringify(vi.mocked(discoveryApi.saveInterest).mock.calls)).not.toContain(
    "개인 저장 금지 원문",
  );
  await userEvent.click(screen.getByRole("button", { name: "평점·리뷰" }));
  expect(screen.getByRole("heading", { name: "술 시음기" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "택배 후기" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "기타 자료" }));
  expect(screen.getByRole("heading", { name: "택배 후기" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "가격" }));
  expect(screen.getByRole("heading", { name: "제품 판매" })).toBeInTheDocument();
});
