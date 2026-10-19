import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectionsApi, externalSourcesApi, productsApi } from "@/api/client";
import { type DiscoveryDocument, type DiscoverySource, discoveryApi } from "@/api/discovery";
import type { Interest } from "@/api/interests";
import type { Product } from "@/api/types";
import { DiscoveryPanel } from "@/components/DiscoveryPanel";
import * as db from "@/sync/db";
import { renderWithQuery } from "@/testing";

const document: DiscoveryDocument = {
  id: "doc",
  url: "https://review.example.com/a?sku=700",
  domain: "review.example.com",
  title: "합성 몰트 12년 46%",
  excerpt: "<script>외부 발췌</script>",
  fetched_at: "2026-09-07T00:00:00Z",
  published_at: null,
  kind: "review",
  evidence: "search_excerpt",
  discovered_by: ["exa"],
  rating: 0,
  rating_scale: 100,
  rating_count: 0,
  applicable_fields: { abv: "46", age_years: "12" },
  evidence_token: "synthetic-evidence", // scan-secrets-allow: synthetic signed-evidence fixture
};
const source: DiscoverySource = {
  source_id: "source",
  source_name: "합성 전문",
  source_url: "https://shop.example.com/a",
  cached: true,
  fields: {},
  raw_excerpt: "합성 상세",
  degraded: true,
  warning: "일부 자료",
  fetched_at: null,
  matched_name: "합성 몰트",
  match_score: null,
  needs_confirmation: true,
  pinned: false,
  candidates: [
    {
      name: "합성 몰트 700ml",
      url: "https://shop.example.com/a?sku=700",
      key: "700",
      product_key: "malt",
      score: 0.8,
      relationship: "same_sku",
      conflicts: ["빈티지 확인"],
      missing: ["도수 확인"],
    },
  ],
  normalized: {
    price_krw: null,
    list_price_krw: null,
    currency: "KRW",
    volume_ml: null,
    rating: 88,
    rating_scale: 100,
    rating_normalized: null,
    review_count: null,
    in_stock: null,
    price_per_100ml: null,
    extra: {},
  },
  llm_recommended_url: null,
  outcome: "partial",
};
const product = {
  id: "product",
  name: "등록 몰트",
  name_en: "Malt",
  producer_name: "Maker",
  abv: "40",
  vintage: 2020,
  age_years: "10",
  country: null,
  region: null,
  skus: [{ volume_ml: 700 }],
  updated_at: "2026-09-07T00:00:00Z",
} as Product;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(connectionsApi, "list").mockResolvedValue([
    { id: "exa", name: "Exa", is_active: true, provider_kind: "exa" },
    { id: "inactive", name: "비활성", is_active: false, provider_kind: "brave" },
    { id: "ocr", name: "OCR", is_active: true, provider_kind: "openai_ocr" },
  ] as never[]);
  vi.spyOn(externalSourcesApi, "list").mockResolvedValue([
    { id: "source", name: "합성 전문", is_active: true },
  ] as never[]);
  vi.spyOn(discoveryApi, "search").mockResolvedValue({
    connection_id: "exa",
    outcome: "partial",
    documents: [
      document,
      {
        ...document,
        id: "doc2",
        url: "https://maker.example.com/a",
        domain: "maker.example.com",
        title: "생산자 정보",
        kind: "info",
        evidence: "provider_text",
        rating: null,
        rating_scale: null,
        rating_count: null,
        published_at: "2026-09-01T00:00:00Z",
        applicable_fields: {},
        evidence_token: null,
      },
    ],
    requests: 1,
    warning: "발췌만 제공",
  });
  vi.spyOn(discoveryApi, "lookup").mockResolvedValue([source]);
  vi.spyOn(discoveryApi, "saveInterest").mockResolvedValue({
    id: "interest",
    name: "관심 몰트",
  } as never);
  vi.spyOn(productsApi, "get").mockResolvedValue(product);
  vi.spyOn(discoveryApi, "productContext").mockResolvedValue({
    identity: { name: product.name },
    source_matches: {},
    updated_at: product.updated_at,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function search() {
  await userEvent.type(screen.getByLabelText("검색할 술"), "관심 몰트");
  await userEvent.click(await screen.findByLabelText("Exa · 검색"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(screen.getByRole("button", { name: "평점·리뷰" }));
  await screen.findByRole("heading", { name: document.title });
}
it("선택한 검색만 실행하고 근거·원척도·도메인·필터·선택 비교를 보여준다", async () => {
  renderWithQuery(<DiscoveryPanel />);
  await search();
  expect(discoveryApi.lookup).not.toHaveBeenCalled();
  expect(screen.queryByText("비활성 · 검색")).not.toBeInTheDocument();
  expect(screen.queryByText("OCR · 검색")).not.toBeInTheDocument();
  expect(screen.getByText(/원문 도메인 2개/)).toHaveTextContent("검색 연결 1개");
  expect(screen.getAllByText("<script>외부 발췌</script>")).toHaveLength(1);
  expect(window.document.querySelector("script")).toBeNull();
  expect(screen.getByText("평점 0 / 100 · 0")).toBeInTheDocument();
  const compare = screen.getAllByLabelText("비교 선택")[0] as HTMLElement;
  await userEvent.click(compare);
  expect(screen.getByRole("table")).toHaveTextContent("0 / 100 (0)");
  await userEvent.click(compare);
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("출처 도메인"), "maker.example.com");
  expect(screen.queryByRole("heading", { name: document.title })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("출처 도메인"), "");
  await userEvent.selectOptions(screen.getByLabelText("자료 구분"), "info");
  expect(screen.queryByRole("heading", { name: document.title })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("자료 구분"), "");
  await userEvent.selectOptions(screen.getByLabelText("정렬"), "recent");
  await userEvent.selectOptions(screen.getByLabelText("정렬"), "domain");
  await userEvent.click(screen.getByRole("button", { name: "평점·리뷰" }));
  expect(screen.queryByRole("heading", { name: "생산자 정보" })).not.toBeInTheDocument();
});
it("후보를 직접 확인해 규격 식별값과 함께 관심에 저장하며 재시도 request_id를 유지한다", async () => {
  vi.spyOn(db, "databaseIdentity").mockReturnValue({ userId: "retry-user", generation: 1 });
  vi.mocked(discoveryApi.saveInterest).mockRejectedValueOnce(new Error("응답 유실"));
  const view = renderWithQuery(<DiscoveryPanel />);
  await userEvent.type(screen.getByLabelText("검색할 술"), "관심 몰트");
  await userEvent.click(screen.getByText("제품 식별 정보 (선택)"));
  for (const [label, value] of [
    ["영문명", "Malt"],
    ["도수", "46"],
    ["빈티지", "2021"],
    ["숙성 연수", "12"],
    ["용량 ml", "700"],
  ])
    await userEvent.type(screen.getByLabelText(label as string), value as string);
  await userEvent.click(await screen.findByLabelText("합성 전문 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml"));
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "평점·리뷰" }));
  expect(screen.getByText(/평점 88 \/ 100/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("응답 유실");
  const first = vi.mocked(discoveryApi.saveInterest).mock.calls[0];
  expect(first?.[0]).toEqual({ name: "합성 몰트 700ml", volumes_ml: [700] });
  expect(first?.[3]).toEqual([source.candidates[0]?.url]);
  expect(first?.[1]).toEqual({
    source: {
      external_url: source.candidates[0]?.url,
      external_name: "합성 몰트 700ml",
      external_key: "700",
      product_key: "malt",
    },
  });
  view.unmount();
  renderWithQuery(<DiscoveryPanel />);
  expect(screen.getByLabelText("저장할 제품명")).toHaveValue("합성 몰트 700ml");
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  await screen.findByText(/관심에 저장했습니다/);
  expect(vi.mocked(discoveryApi.saveInterest).mock.calls[1]).toEqual(first);
  expect(screen.getByRole("button", { name: "관심에 저장" })).toBeDisabled();
});
it("새 관심에서 두 번째 출처 후보를 골라도 첫 출처 고정을 지우지 않는다", async () => {
  vi.spyOn(db, "databaseIdentity").mockReturnValue({ userId: "pin-user", generation: 1 });
  const second: DiscoverySource = {
    ...source,
    source_id: "source2",
    source_name: "합성 두번째",
    source_url: "https://other.example.com/b",
    candidates: [
      {
        ...(source.candidates[0] as DiscoverySource["candidates"][number]),
        name: "합성 몰트 700ml 다른 판매처",
        url: "https://other.example.com/b?sku=700",
        key: "b700",
      },
    ],
  };
  vi.mocked(discoveryApi.lookup).mockResolvedValue([source, second]);
  renderWithQuery(<DiscoveryPanel />);
  await userEvent.type(screen.getByLabelText("검색할 술"), "관심 몰트");
  await userEvent.click(await screen.findByLabelText("합성 전문 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml"));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml 다른 판매처"));
  expect(screen.getByLabelText("합성 몰트 700ml")).toBeChecked();
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  await screen.findByText(/관심에 저장했습니다/);

  const call = vi.mocked(discoveryApi.saveInterest).mock.calls[0];
  expect(call?.[0]).toEqual({ name: "합성 몰트 700ml", volumes_ml: [700] });
  expect(Object.keys(call?.[1] ?? {}).sort()).toEqual(["source", "source2"]);
  expect(call?.[3]).toEqual([source.candidates[0]?.url, second.candidates[0]?.url]);
});
it("새 관심에서 다시 검색하면 앞 검색의 고정은 새 선택과 함께 저장하지 않는다", async () => {
  vi.spyOn(db, "databaseIdentity").mockReturnValue({ userId: "pin-user", generation: 1 });
  const second: DiscoverySource = {
    ...source,
    source_id: "source2",
    source_name: "합성 두번째",
    source_url: "https://other.example.com/b",
    candidates: [
      {
        ...(source.candidates[0] as DiscoverySource["candidates"][number]),
        name: "합성 몰트 700ml 다른 판매처",
        url: "https://other.example.com/b?sku=700",
        key: "b700",
      },
    ],
  };
  vi.mocked(discoveryApi.lookup).mockResolvedValueOnce([source]).mockResolvedValueOnce([second]);
  renderWithQuery(<DiscoveryPanel />);
  await userEvent.type(screen.getByLabelText("검색할 술"), "관심 몰트");
  await userEvent.click(await screen.findByLabelText("합성 전문 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml 다른 판매처"));
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  await screen.findByText(/관심에 저장했습니다/);

  const call = vi.mocked(discoveryApi.saveInterest).mock.calls[0];
  expect(Object.keys(call?.[1] ?? {})).toEqual(["source2"]);
  expect(call?.[3]).toEqual([second.candidates[0]?.url]);
  expect(vi.mocked(discoveryApi.lookup).mock.calls[1]?.[2]).toEqual({});
});
it("새 관심에서 같은 출처의 다른 후보로 바꾸면 식별값·고정·근거를 모두 새 후보로 바꾼다", async () => {
  vi.spyOn(db, "databaseIdentity").mockReturnValue({ userId: "pin-user", generation: 1 });
  const first = source.candidates[0] as DiscoverySource["candidates"][number];
  const other = {
    ...first,
    name: "합성 몰트 500ml",
    url: "https://example.com/a?sku=500",
    key: "a500",
  };
  vi.mocked(discoveryApi.lookup).mockResolvedValue([{ ...source, candidates: [first, other] }]);
  renderWithQuery(<DiscoveryPanel />);
  await userEvent.type(screen.getByLabelText("검색할 술"), "관심 몰트");
  await userEvent.click(await screen.findByLabelText("합성 전문 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml"));
  await userEvent.click(screen.getByLabelText("합성 몰트 500ml"));
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  await screen.findByText(/관심에 저장했습니다/);

  const call = vi.mocked(discoveryApi.saveInterest).mock.calls[0];
  expect(call?.[0]).toEqual({ name: "합성 몰트 500ml", volumes_ml: [500] });
  expect(call?.[1]?.source?.external_url).toBe(other.url);
  expect(call?.[3]).toEqual([other.url]);
});
it("제품의 현재값과 근거를 비교하고 선택한 필드만 원래 revision으로 적용한다", async () => {
  vi.spyOn(discoveryApi, "apply").mockRejectedValueOnce(
    new Error("다른 화면에서 제품을 수정했습니다"),
  );
  renderWithQuery(<DiscoveryPanel productId="product" />);
  await search();
  await userEvent.click(screen.getByText("제품 정보 비교·선택 적용"));
  expect(screen.getByText("제목에서 추출·적용 전 대상 확인")).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText("도수: 40 → 46"));
  expect(screen.getByLabelText("국가: 없음 → 근거 없음")).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "선택한 정보 적용" }));
  expect(discoveryApi.apply).toHaveBeenCalledWith(
    "product",
    product.updated_at,
    "synthetic-evidence",
    ["abv"],
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("다른 화면에서 제품을 수정했습니다");
  vi.mocked(discoveryApi.apply).mockResolvedValue({
    product_id: "product",
    updated_at: "new",
    applied_fields: { abv: "46" },
    source_url: document.url,
  });
  await userEvent.click(screen.getByRole("button", { name: "선택한 정보 적용" }));
  await screen.findByText("선택한 정보를 적용했습니다.");
  expect(screen.getByRole("button", { name: "선택한 정보 적용" })).toBeDisabled();
});
it("한글 조합 중 Enter는 실행하지 않고 취소 뒤 늦은 응답을 무시한다", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof discoveryApi.search>>) => void;
  vi.mocked(discoveryApi.search).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  renderWithQuery(<DiscoveryPanel initialName="관심" />);
  await userEvent.click(await screen.findByLabelText("Exa · 검색"));
  const input = screen.getByLabelText("검색할 술");
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(discoveryApi.search).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(screen.getByRole("button", { name: "조회 취소" }));
  await act(async () =>
    resolve({
      connection_id: "exa",
      outcome: "success",
      documents: [document],
      requests: 1,
      warning: null,
    }),
  );
  expect(screen.queryByRole("heading", { name: document.title })).not.toBeInTheDocument();
  expect(screen.getByText(/조회 취소 · 완료된 결과 유지/)).toBeInTheDocument();
});
it("검색명과 선택만 새로고침 draft로 복구하고 자료·증거는 로컬 저장하지 않는다", async () => {
  vi.spyOn(db, "databaseIdentity").mockReturnValue({ userId: "draft-user", generation: 1 });
  const view = renderWithQuery(<DiscoveryPanel />);
  await search();
  const drafts = Object.entries(localStorage).filter(([key]) => key.startsWith("sooljang-draft"));
  expect(JSON.stringify(drafts)).toContain("관심 몰트");
  expect(JSON.stringify(drafts)).not.toContain("synthetic-evidence");
  expect(JSON.stringify(drafts)).not.toContain("外部");
  expect(JSON.stringify(drafts)).not.toContain(document.excerpt);
  view.unmount();
  renderWithQuery(<DiscoveryPanel />);
  expect(screen.getByLabelText("검색할 술")).toHaveValue("관심 몰트");
  expect(await screen.findByLabelText("Exa · 검색")).toBeChecked();
  expect(screen.queryByRole("heading", { name: document.title })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "연결 설정" }));
  expect(window.location.hash).toBe("#settings");
});
it("오프라인·연결 조회 실패·빈 결과를 각각 안내한다", async () => {
  const view = renderWithQuery(<DiscoveryPanel offline initialName="술" />);
  expect(screen.getByRole("button", { name: "관심에 저장" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "앱에서 검색" })).toBeDisabled();
  view.unmount();
  vi.mocked(connectionsApi.list).mockRejectedValue(new Error("network"));
  vi.mocked(externalSourcesApi.list).mockResolvedValue([]);
  renderWithQuery(<DiscoveryPanel />);
  expect(await screen.findByRole("alert")).toHaveTextContent("연결 목록");
  expect(screen.getByText(/활성 연결이 없습니다/)).toBeInTheDocument();
});
it("계정 변경 뒤 관심 저장의 늦은 성공을 표시하지 않는다", async () => {
  let owner = { userId: "one", generation: 1 };
  vi.spyOn(db, "databaseIdentity").mockImplementation(() => owner);
  let resolve!: (value: Awaited<ReturnType<typeof discoveryApi.saveInterest>>) => void;
  vi.mocked(discoveryApi.saveInterest).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  renderWithQuery(<DiscoveryPanel initialName="관심" />);
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  await waitFor(() => expect(discoveryApi.saveInterest).toHaveBeenCalled());
  owner = { userId: "two", generation: 2 };
  await act(async () => resolve({ id: "interest", name: "이전 계정" } as never));
  expect(screen.queryByText(/관심에 저장했습니다/)).not.toBeInTheDocument();
});

it("등록 제품의 현재 식별 정보와 기존 고정·선호 판매처를 관심에 보존한다", async () => {
  const pins = {
    source: {
      external_url: "https://shop.example.com/pinned",
      external_name: "고정 몰트",
      external_key: "sku-700",
      product_key: "malt",
      preferred_seller_key: "seller",
    },
  };
  const identity = { name: "등록 몰트", abv: "40", vintage: 2020, volumes_ml: [700, 200] };
  vi.mocked(discoveryApi.productContext).mockResolvedValue({
    identity,
    source_matches: pins,
    updated_at: product.updated_at,
  });
  vi.spyOn(discoveryApi, "productLookup").mockResolvedValue([source]);
  renderWithQuery(<DiscoveryPanel productId="product" initialName="등록 몰트" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "관심에 저장" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "관심에 저장" }));
  expect(discoveryApi.saveInterest).toHaveBeenCalledWith(
    identity,
    pins,
    expect.any(String),
    undefined,
  );
  await userEvent.click(await screen.findByLabelText("합성 전문 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await waitFor(() =>
    expect(discoveryApi.productLookup).toHaveBeenCalledWith(
      "product",
      "source",
      expect.any(AbortSignal),
    ),
  );
  expect(discoveryApi.lookup).not.toHaveBeenCalled();
});
it("저장된 관심 ID로 재조회하고 후보 고정을 revision 검사로 갱신한다", async () => {
  const interest = {
    id: "interest",
    name: "관심 몰트",
    identity: { name: "관심 몰트", abv: "40", vintage: 2020, volumes_ml: [700] },
    source_matches: {},
    updated_at: "2026-09-07T00:00:00Z",
    archived: false,
    note: null,
    product_id: null,
  };
  const { interestsApi } = await import("@/api/interests");
  vi.spyOn(discoveryApi, "interestLookup").mockResolvedValue([source]);
  vi.spyOn(interestsApi, "update").mockResolvedValue(interest);
  renderWithQuery(<DiscoveryPanel interest={interest} />);
  await userEvent.click(await screen.findByLabelText("합성 전문 · 전문 소스"));
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByLabelText("합성 몰트 700ml"));
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "후보 고정 저장" }));
  expect(discoveryApi.interestLookup).toHaveBeenCalledWith(
    "interest",
    "source",
    expect.any(AbortSignal),
  );
  expect(interestsApi.update).toHaveBeenCalledWith("interest", {
    expected_updated_at: interest.updated_at,
    reference_urls: [source.candidates[0]?.url],
    source_matches: {
      source: {
        external_url: source.candidates[0]?.url,
        external_name: "합성 몰트 700ml",
        external_key: "700",
        product_key: "malt",
      },
    },
  });
  expect(discoveryApi.saveInterest).not.toHaveBeenCalled();
});

const linkA = "https://example.com/a";
const linkB = "https://example.com/b";
const linkC = "https://example.com/c";
const savedInterest: Interest = {
  id: "interest",
  name: "관심 몰트",
  identity: { name: "관심 몰트" },
  source_matches: {},
  reference_urls: [linkA],
  updated_at: "2026-10-12T00:00:00Z",
  archived: false,
  note: null,
  product_id: null,
};

async function selectAndSaveReference(url: string) {
  vi.mocked(discoveryApi.search).mockResolvedValue({
    connection_id: "exa",
    outcome: "success",
    documents: [{ ...document, id: url, url, kind: "info" }],
    requests: 1,
    warning: null,
  });
  await userEvent.click(screen.getByRole("button", { name: "앱에서 검색" }));
  await userEvent.click(await screen.findByRole("button", { name: "이 자료를 관심에 연결" }));
  await userEvent.click(screen.getByLabelText("제품명·판본·규격과 선택 출처를 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "후보 고정 저장" }));
}

it.each([
  "delayed",
  "failed",
] as const)("%s refetch에도 연속 저장의 서버 URL 목록·고정·revision을 함께 보존한다", async (refetch) => {
  const { interestsApi } = await import("@/api/interests");
  let resolveList!: (value: (typeof savedInterest)[]) => void;
  const list = vi.spyOn(interestsApi, "list").mockImplementation(() =>
    refetch === "failed"
      ? Promise.reject(new Error("목록 조회 실패"))
      : new Promise((resolve) => {
          resolveList = resolve;
        }),
  );
  let server = { ...savedInterest };
  const responseMatch = {
    external_url: linkA,
    external_name: "서버에 보관된 고정",
    external_key: null,
    product_key: null,
  };
  const update = vi.spyOn(interestsApi, "update").mockImplementation(async (_id, input) => {
    if (input.expected_updated_at !== server.updated_at) throw new Error("revision 충돌");
    server = {
      ...server,
      ...input,
      source_matches: { ...input.source_matches, server: responseMatch },
      reference_urls: input.reference_urls ?? server.reference_urls ?? [],
      updated_at: `2026-10-12T00:00:0${update.mock.calls.length}Z`,
    };
    return server;
  });
  const { useQuery } = await import("@tanstack/react-query");
  function InterestList() {
    const query = useQuery({
      queryKey: ["interests"],
      queryFn: interestsApi.list,
      initialData: [savedInterest],
      staleTime: Infinity,
    });
    return <DiscoveryPanel interest={query.data[0] as Interest} />;
  }
  renderWithQuery(<InterestList />);
  await userEvent.click(await screen.findByLabelText("Exa · 검색"));
  await selectAndSaveReference(linkB);
  await screen.findByText(/관심에 저장했습니다/);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  expect(server.reference_urls).toEqual([linkA, linkB]);
  await selectAndSaveReference(linkC);
  await screen.findByText(/관심에 저장했습니다/);
  expect(update.mock.calls[1]?.[1]).toMatchObject({
    expected_updated_at: "2026-10-12T00:00:01Z",
    reference_urls: [linkA, linkB, linkC],
    source_matches: { server: responseMatch },
  });
  expect(server.reference_urls).toEqual([linkA, linkB, linkC]);
  if (refetch === "delayed") {
    // A stale list response arriving after both writes must not roll the baseline back.
    await act(async () => resolveList([savedInterest]));
    await selectAndSaveReference(linkB);
    await screen.findByText(/관심에 저장했습니다/);
    expect(update.mock.calls[2]?.[1]).toMatchObject({
      expected_updated_at: "2026-10-12T00:00:02Z",
      reference_urls: [linkA, linkB, linkC],
    });
  }
});

it("다른 화면의 수정은 작성 기준 revision과 충돌하며 서버 URL을 덮어쓰지 않는다", async () => {
  const { interestsApi } = await import("@/api/interests");
  let server = { ...savedInterest };
  const update = vi.spyOn(interestsApi, "update").mockImplementation(async (_id, input) => {
    if (input.expected_updated_at !== server.updated_at)
      throw new Error("다른 화면에서 변경했습니다");
    server = {
      ...server,
      reference_urls: input.reference_urls ?? server.reference_urls ?? [],
      updated_at: "2026-10-12T00:00:01Z",
    };
    return server;
  });
  const view = renderWithQuery(<DiscoveryPanel interest={savedInterest} />);
  await userEvent.click(await screen.findByLabelText("Exa · 검색"));
  await selectAndSaveReference(linkB);
  await screen.findByText(/관심에 저장했습니다/);
  server = {
    ...server,
    reference_urls: [linkA, linkB, "https://example.com/other"],
    updated_at: "2026-10-12T00:00:02Z",
  };
  view.rerender(<DiscoveryPanel interest={server} />);
  await selectAndSaveReference(linkC);
  expect(await screen.findByRole("alert")).toHaveTextContent("다른 화면에서 변경했습니다");
  expect(update.mock.calls[1]?.[1].expected_updated_at).toBe("2026-10-12T00:00:01Z");
  expect(server.reference_urls).toEqual([linkA, linkB, "https://example.com/other"]);
  expect(screen.queryByText(/관심에 저장했습니다/)).not.toBeInTheDocument();
  // Reopening adopts the refreshed complete snapshot and permits an explicit retry.
  view.unmount();
  renderWithQuery(<DiscoveryPanel interest={server} />);
  const connection = await screen.findByLabelText("Exa · 검색");
  if (!(connection as HTMLInputElement).checked) await userEvent.click(connection);
  await selectAndSaveReference(linkC);
  await screen.findByText(/관심에 저장했습니다/);
  expect(update.mock.calls[2]?.[1]).toMatchObject({
    expected_updated_at: "2026-10-12T00:00:02Z",
    reference_urls: [linkA, linkB, "https://example.com/other", linkC],
  });
  expect(server.reference_urls).toEqual([linkA, linkB, "https://example.com/other", linkC]);
});
