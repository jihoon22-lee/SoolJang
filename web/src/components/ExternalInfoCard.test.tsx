import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ExternalOffer, NormalizedFields, SourceLookupResult } from "@/api/types";
import { ExternalInfoCard } from "@/components/ExternalInfoCard";
import { stubRoutes as originalStubRoutes, renderWithQuery } from "@/testing";

function stubRoutes(routes: Parameters<typeof originalStubRoutes>[0]) {
  return originalStubRoutes([
    ...routes.map((route) => ({
      ...route,
      match: route.match.replace("/products/p1/external-lookup", "/discovery/products/p1/lookup"),
    })),
    {
      match: "/discovery/products/p1/context",
      body: {
        identity: { name: "합성 제품" },
        source_matches: {},
        updated_at: "2026-09-07T00:00:00Z",
      },
    },
    { match: "/connections", body: [] },
    { match: "/external-sources", body: [{ id: "s1", name: "조회 소스", is_active: true }] },
    {
      match: "/products/p1",
      body: { id: "p1", name: "합성 제품", skus: [], updated_at: "2026-09-07T00:00:00Z" },
    },
  ]);
}
async function lookup() {
  await userEvent.click(screen.getByText("외부 정보 조회", { selector: "summary" }));
  await userEvent.click(await screen.findByLabelText("조회 소스 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(screen.getByRole("button", { name: "가격" }));
}

function normalized(overrides: Partial<NormalizedFields> = {}): NormalizedFields {
  return {
    price_krw: null,
    list_price_krw: null,
    currency: "KRW",
    volume_ml: null,
    rating: null,
    rating_scale: null,
    rating_normalized: null,
    review_count: null,
    in_stock: null,
    price_per_100ml: null,
    extra: {},
    ...overrides,
  };
}

function result(overrides: Partial<SourceLookupResult> = {}): SourceLookupResult {
  return {
    source_id: "s1",
    source_name: "데일리샷",
    cached: false,
    source_url: "https://dailyshot.co/item/123",
    fields: { price_krw: 45000, volume_ml: 900 },
    raw_excerpt: null,
    degraded: false,
    warning: null,
    fetched_at: "2026-08-13T00:00:00Z",
    matched_name: null,
    match_score: null,
    needs_confirmation: false,
    pinned: false,
    candidates: [],
    normalized: normalized({ price_krw: 45000, volume_ml: 900, price_per_100ml: "5000.00" }),
    llm_recommended_url: null,
    ...overrides,
  };
}

describe("ExternalInfoCard", () => {
  it("오프라인이면 검색을 비활성화하고 보조 검색 링크를 제공한다", async () => {
    renderWithQuery(<ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline />);
    await userEvent.click(screen.getByText("외부 정보 조회", { selector: "summary" }));
    expect(screen.getByRole("button", { name: "앱에서 검색" })).toBeDisabled();
    expect(screen.getByText(/오프라인입니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("외부 브라우저에서 보조 검색"));
    expect(screen.getByRole("link", { name: "Google에서 검색" })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  it("조회 버튼을 누르면 표준 필드를 표로 보여준다", async () => {
    stubRoutes([{ match: "/products/p1/external-lookup", method: "POST", body: [result()] }]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await lookup();

    expect(await screen.findByText("데일리샷")).toBeInTheDocument();
    expect(screen.getByText("45,000원")).toBeInTheDocument();
    expect(screen.getByText("5,000원")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "출처 보기" })).toHaveAttribute(
      "href",
      "https://dailyshot.co/item/123",
    );
  });

  it("판매 조건이 없는 기존 단일 가격에는 최저 배지를 붙이지 않는다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            source_id: "s1",
            source_name: "데일리샷",
            normalized: normalized({
              price_krw: 45000,
              volume_ml: 900,
              price_per_100ml: "5000.00",
            }),
          }),
          result({
            source_id: "s2",
            source_name: "이마트몰",
            normalized: normalized({
              price_krw: 63000,
              volume_ml: 900,
              price_per_100ml: "7000.00",
            }),
          }),
        ],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await lookup();
    await screen.findByText("데일리샷");

    const rows = screen.getAllByRole("row");
    const dailyshotRow = rows.find((row) => row.textContent?.includes("데일리샷"));
    const emartRow = rows.find((row) => row.textContent?.includes("이마트몰"));
    expect(dailyshotRow?.textContent).not.toContain("최저");
    expect(emartRow?.textContent).not.toContain("최저");
  });

  it("내 실평단가를 주면 소스 가격과의 델타를 보여준다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            normalized: normalized({
              price_krw: 55000,
              volume_ml: 1000,
              price_per_100ml: "5500.00",
            }),
          }),
        ],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard
        productId="p1"
        productName="글렌알라키 12년"
        offline={false}
        myPricePer100ml="5000.00"
      />,
    );

    await lookup();

    expect(await screen.findByText(/내 가격 대비 \+10%/)).toBeInTheDocument();
  });

  it("표준 키가 아닌 값은 상세에서 손실 없이 보인다", async () => {
    stubRoutes([
      {
        match: "/products/p1/external-lookup",
        method: "POST",
        body: [
          result({
            matched_name: "글렌알라키 12년",
            match_score: 1,
            fields: { 메모: "인기 상품" },
            normalized: normalized({ extra: { 메모: "인기 상품" } }),
          }),
        ],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await lookup();
    await userEvent.click(await screen.findByRole("button", { name: "상세" }));

    expect(screen.getByText("메모")).toBeInTheDocument();
    expect(screen.getByText("인기 상품")).toBeInTheDocument();
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

    await lookup();

    expect(await screen.findByText("일부 정보만 확인됨")).toBeInTheDocument();
    expect(screen.getByText("평점을 찾지 못했습니다")).toBeInTheDocument();
  });

  it("등록된 소스가 없으면 안내를 보여준다", async () => {
    stubRoutes([{ match: "/products/p1/external-lookup", method: "POST", body: [] }]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await lookup();

    expect(await screen.findByText(/조회 완료/)).toBeInTheDocument();
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

    await lookup();

    expect(await screen.findByText(/조회 소스: 서버 오류/)).toBeInTheDocument();
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

    await lookup();

    expect(await screen.findByText(/이 술이 맞는지 확인해 주세요/)).toBeInTheDocument();
    expect(screen.getByText("글렌알라키 10년 CS")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "이걸로 고정" })).toHaveLength(2);
  });

  it("LLM이 추천한 후보에 배지를 붙이되 자동으로 고정하지 않는다(Task 34 PR6)", async () => {
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
            llm_recommended_url: "https://d.co/2",
          }),
        ],
      },
    ]);
    renderWithQuery(
      <ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline={false} />,
    );

    await lookup();
    await screen.findByText(/이 술이 맞는지 확인해 주세요/);

    const recommendedCandidate = screen.getByText("글렌알라키 10년 CS").closest("li");
    expect(recommendedCandidate).not.toBeNull();
    expect(recommendedCandidate).toHaveTextContent("LLM 추천");
    const otherCandidate = screen.getByText("글렌알라키 12년 셰리").closest("li");
    expect(otherCandidate).not.toHaveTextContent("LLM 추천");
    // 배지가 있어도 고정 버튼은 여전히 두 후보 모두에서 사용자 클릭을 요구한다 —
    // 자동으로 고정되지 않는다는 것이 이 배지의 핵심 제약이다.
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

    await lookup();
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

    await lookup();

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
    await lookup();
    await screen.findByRole("button", { name: "이걸로 고정" });

    rerender(<ExternalInfoCard productId="p1" productName="글렌알라키 12년" offline />);

    expect(screen.getByRole("button", { name: "이걸로 고정" })).toBeDisabled();
  });
});

function offer(overrides: Partial<ExternalOffer> = {}): ExternalOffer {
  return {
    product_key: "harbor",
    offer_key: "a",
    condition_key: "a",
    source_url: "https://example.com/a",
    name: "Harbor 700ml",
    amount: "60000",
    currency: "KRW",
    volume_ml: 700,
    units: 1,
    is_set: false,
    seller_key: "a",
    seller_name: "합성 매장 A",
    branch: null,
    price_kind: "listed",
    membership: "none",
    coupon: "none",
    fulfillment: "pickup",
    region: "서울",
    shipping: "none",
    tax: "included",
    in_stock: null,
    fetched_at: "2026-09-07T00:00:00Z",
    source_observed_at: null,
    comparison_group: "same",
    needs_confirmation: false,
    relationship: "same_sku",
    collection_scope: "검색 응답",
    ...overrides,
  };
}

it("고정 상품의 판매처 세 곳과 별도 규격을 보존하고 동일 조건 가격만 비교한다", async () => {
  stubRoutes([
    {
      match: "/products/p1/external-lookup",
      method: "POST",
      body: [
        result({
          pinned: true,
          cached: true,
          offers: [
            offer(),
            offer({ condition_key: "b", seller_name: "합성 매장 B", amount: "59000" }),
            offer({ condition_key: "c", seller_name: "합성 매장 C", amount: "58000" }),
            offer({
              condition_key: "small",
              seller_name: null,
              amount: "10000",
              volume_ml: 200,
              comparison_group: null,
              membership: null,
            }),
          ],
        }),
      ],
    },
  ]);
  renderWithQuery(<ExternalInfoCard productId="p1" productName="Harbor" offline={false} />);
  await lookup();
  expect(await screen.findByText("확인한 판매 조건 4건")).toBeInTheDocument();
  const badge = screen.getByText("확인한 판매처 중 동일 조건 최저가");
  expect(badge.closest("tr")).toHaveTextContent("합성 매장 C");
  expect(screen.getAllByText("캐시 · 새 관측 아님")).toHaveLength(4);
  expect(screen.getByText("판매자 미확인")).toBeInTheDocument();
  expect(screen.getByText(/회원 조건: 미확인/)).toBeInTheDocument();
});

it("실패 후 마지막 관측과 미확인 판매 조건을 별도로 표시한다", async () => {
  stubRoutes([
    {
      match: "/products/p1/external-lookup",
      method: "POST",
      body: [
        result({
          degraded: true,
          offers: [
            offer({
              last_good: true,
              comparison_group: null,
              needs_confirmation: true,
              is_set: true,
              units: 2,
              in_stock: false,
              price_kind: "member",
              source_observed_at: "2026-09-06T00:00:00Z",
            }),
          ],
        }),
      ],
    },
  ]);
  renderWithQuery(<ExternalInfoCard productId="p1" productName="Harbor" offline={false} />);
  await lookup();
  expect(await screen.findByText("최근 조회 실패 · 마지막 확인 가격")).toBeInTheDocument();
  expect(screen.getByText("제품·규격 확인 필요")).toBeInTheDocument();
  expect(screen.queryByText("확인한 판매처 중 동일 조건 최저가")).not.toBeInTheDocument();
});
