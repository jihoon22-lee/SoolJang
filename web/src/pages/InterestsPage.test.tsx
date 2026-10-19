import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productsApi, vendorsApi } from "@/api/client";
import { type Interest, interestsApi } from "@/api/interests";
import { todayLocal } from "@/format";
import { InterestsPage } from "@/pages/InterestsPage";
import { activateDatabase, lockDatabase } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery } from "@/testing";

const item: Interest = {
  id: "interest-1",
  name: "합성 몰트",
  identity: {
    name: "합성 몰트",
    volumes_ml: [700],
    abv: "43",
    vintage: 2020,
    search_aliases: ["합성몰트"],
  },
  source_matches: {},
  note: "첫 노트",
  archived: false,
  product_id: null,
  updated_at: "2026-09-07T00:00:00Z",
};
beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("interest-page-owner");
  vi.spyOn(interestsApi, "list").mockResolvedValue([
    item,
    { ...item, id: "interest-2", name: "다른 몰트", identity: { name: "다른 몰트" }, note: null },
    { ...item, id: "archived", name: "보관한 몰트", archived: true, product_id: "linked-product" },
  ]);
  vi.spyOn(interestsApi, "create").mockResolvedValue(item);
  vi.spyOn(interestsApi, "update").mockResolvedValue(item);
  vi.spyOn(interestsApi, "purchase").mockResolvedValue({
    interest_id: item.id,
    purchase_id: "new-purchase",
    product_id: "new-product",
  });
  vi.spyOn(productsApi, "list").mockResolvedValue({
    items: [{ id: "product-1", name: "확정 제품", vintage: 2021, abv: "46" }] as never[],
    next_cursor: null,
  });
  vi.spyOn(productsApi, "get").mockResolvedValue({
    id: "product-1",
    skus: [{ id: "sku-1", volume_ml: 700, package_note: "개별 상자" }],
  } as never);
  vi.spyOn(vendorsApi, "list").mockResolvedValue([{ id: "vendor-1", name: "합성 샵" }] as never[]);
});
afterEach(() => {
  lockDatabase();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function renderPage() {
  const onSelectProduct = vi.fn();
  renderWithQuery(
    <SyncStatusProvider>
      <InterestsPage onSelectProduct={onSelectProduct} />
    </SyncStatusProvider>,
  );
  return onSelectProduct;
}
it("관심의 규격·도수·빈티지·노트를 저장하고 두 관심을 비교한다", async () => {
  renderPage();
  await userEvent.click(screen.getByRole("button", { name: "관심 추가" }));
  await userEvent.type(screen.getByLabelText("관심 제품 이름"), "신규 관심");
  await userEvent.type(screen.getByLabelText("용량 ml (여러 규격은 쉼표로 구분)"), "500");
  await userEvent.type(screen.getByLabelText("도수 %"), "40");
  await userEvent.type(screen.getByLabelText("빈티지"), "2022");
  await userEvent.type(screen.getByLabelText("관심 노트"), "나중에 살 술");
  await userEvent.click(screen.getByRole("button", { name: "관심 저장" }));
  await waitFor(() =>
    expect(interestsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "신규 관심", volumes_ml: [500], abv: "40", vintage: 2022 }),
      "나중에 살 술",
      expect.any(String),
      [],
    ),
  );
  const choices = await screen.findAllByLabelText("비교 선택");
  await userEvent.click(choices[0] as HTMLElement);
  await userEvent.click(choices[1] as HTMLElement);
  expect(screen.getByRole("table")).toHaveTextContent("용량");
  expect(screen.getByRole("table")).toHaveTextContent("미상");
  await userEvent.click(choices[1] as HTMLElement);
  const row = screen.getByRole("heading", { name: "합성 몰트" }).closest("li");
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "수정" }));
  await userEvent.clear(screen.getByLabelText("관심 노트"));
  await userEvent.type(screen.getByLabelText("관심 노트"), "업데이트 노트");
  await userEvent.click(screen.getByRole("button", { name: "변경 저장" }));
  await waitFor(() =>
    expect(interestsApi.update).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        note: "업데이트 노트",
        expected_updated_at: item.updated_at,
      }),
    ),
  );
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "관심 보관" }));
  await waitFor(() =>
    expect(interestsApi.update).toHaveBeenCalledWith(item.id, {
      archived: true,
      expected_updated_at: item.updated_at,
    }),
  );
});
it("새 제품 구매는 확인 전에는 생성하지 않고 선물·포인트 구매의 가격 공란을 허용한다", async () => {
  const onSelectProduct = renderPage();
  const row = (await screen.findByRole("heading", { name: "합성 몰트" })).closest("li");
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "구매 전환" }));
  const conversion = screen.getByRole("region", { name: "관심 구매 전환" });
  expect(within(conversion).getByRole("button", { name: "구매와 병 생성" })).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText("등록 방식"), "new");
  await userEvent.clear(screen.getByLabelText("새 제품 이름"));
  await userEvent.type(screen.getByLabelText("새 제품 이름"), "확정 새 몰트");
  await userEvent.clear(screen.getByLabelText("구매한 용량 ml"));
  await userEvent.type(screen.getByLabelText("구매한 용량 ml"), "750");
  await userEvent.clear(screen.getByLabelText("확정 도수 %"));
  await userEvent.type(screen.getByLabelText("확정 도수 %"), "45");
  await userEvent.clear(screen.getByLabelText("확정 빈티지"));
  await userEvent.type(screen.getByLabelText("확정 빈티지"), "2021");
  await userEvent.clear(screen.getByLabelText("구매 병수"));
  await userEvent.type(screen.getByLabelText("구매 병수"), "2");
  await userEvent.selectOptions(screen.getByLabelText("구매처"), "vendor-1");
  await userEvent.clear(screen.getByLabelText("구매일"));
  await userEvent.type(screen.getByLabelText("구매일"), "2026-09-07");
  await userEvent.type(screen.getByLabelText("병당 정가 (원)"), "1000");
  await userEvent.type(screen.getByLabelText("병당 실구매가 (원)"), "0");
  await userEvent.click(screen.getByLabelText("제품·판본·규격과 실제 구매 내용을 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "구매와 병 생성" }));
  await waitFor(() => expect(onSelectProduct).toHaveBeenCalledWith("new-product"));
  expect(interestsApi.purchase).toHaveBeenCalledWith(
    item.id,
    expect.objectContaining({
      quantity: 2,
      unit_paid_price: "0",
      unit_list_price: "1000",
      purchased_on: "2026-09-07",
      new_product: expect.objectContaining({
        name: "확정 새 몰트",
        volume_ml: 750,
        abv: "45",
        vintage: 2021,
        search_aliases: ["합성몰트"],
      }),
    }),
  );
});
it("관심 별칭이 제품 상한보다 많으면 앞의 20개만 새 제품으로 옮긴다", async () => {
  const aliases = Array.from({ length: 25 }, (_, index) => `합성별칭${index + 1}`);
  vi.mocked(interestsApi.list).mockResolvedValue([
    { ...item, identity: { ...item.identity, search_aliases: aliases } },
  ]);
  renderPage();
  const row = (await screen.findByRole("heading", { name: "합성 몰트" })).closest("li");
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "구매 전환" }));
  await userEvent.selectOptions(screen.getByLabelText("등록 방식"), "new");
  await userEvent.clear(screen.getByLabelText("구매한 용량 ml"));
  await userEvent.type(screen.getByLabelText("구매한 용량 ml"), "700");
  await userEvent.click(screen.getByLabelText("제품·판본·규격과 실제 구매 내용을 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "구매와 병 생성" }));

  await waitFor(() => expect(interestsApi.purchase).toHaveBeenCalled());
  const input = vi.mocked(interestsApi.purchase).mock.calls[0]?.[1];
  expect(input?.new_product?.search_aliases).toEqual(aliases.slice(0, 20));
});
it("기존 제품·규격을 확정하고 보관 목록에서 연결 제품으로 이동한다", async () => {
  const onSelectProduct = renderPage();
  const row = (await screen.findByRole("heading", { name: "합성 몰트" })).closest("li");
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "구매 전환" }));
  await userEvent.clear(screen.getByLabelText("기존 제품 검색"));
  await userEvent.type(screen.getByLabelText("기존 제품 검색"), "확정");
  await screen.findByRole("option", { name: /확정 제품/ });
  await userEvent.selectOptions(screen.getByLabelText("구매한 제품"), "product-1");
  await screen.findByRole("option", { name: "700 ml · 개별 상자" });
  await userEvent.selectOptions(screen.getByLabelText("구매한 규격"), "sku-1");
  await userEvent.click(screen.getByLabelText("제품·판본·규격과 실제 구매 내용을 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "구매와 병 생성" }));
  await waitFor(() =>
    expect(interestsApi.purchase).toHaveBeenCalledWith(
      item.id,
      // 구매일은 일반 등록처럼 오늘로 시작한다(공란이면 기간 통계에서 빠진다).
      expect.objectContaining({
        sku_id: "sku-1",
        unit_paid_price: null,
        purchased_on: todayLocal(),
      }),
    ),
  );
  await userEvent.selectOptions(screen.getByLabelText("관심 상태"), "purchased");
  await userEvent.click(await screen.findByRole("button", { name: "구매 전환한 제품 보기" }));
  expect(onSelectProduct).toHaveBeenCalledWith("linked-product");
  await userEvent.click(screen.getByRole("button", { name: "관심 복원" }));
  await waitFor(() =>
    expect(interestsApi.update).toHaveBeenCalledWith("archived", {
      archived: false,
      expected_updated_at: item.updated_at,
    }),
  );
});
it("관심 저장 실패를 알리고 입력을 유지한다", async () => {
  vi.mocked(interestsApi.create).mockRejectedValue(new Error("저장 실패"));
  renderPage();
  await userEvent.click(screen.getByRole("button", { name: "관심 추가" }));
  await userEvent.type(screen.getByLabelText("관심 제품 이름"), "유지할 관심");
  await userEvent.click(screen.getByRole("button", { name: "관심 저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("저장 실패");
  expect(screen.getByLabelText("관심 제품 이름")).toHaveValue("유지할 관심");
});

it("다른 화면의 갱신 후에도 작성 시작 시점의 revision으로 노트를 저장한다", async () => {
  const refreshed = { ...item, note: "서버에서 변경한 노트", updated_at: "2026-09-07T01:00:00Z" };
  vi.mocked(interestsApi.list).mockResolvedValueOnce([item]).mockResolvedValue([refreshed]);
  vi.mocked(interestsApi.update).mockRejectedValueOnce(new Error("다른 화면에서 변경했습니다"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderWithQuery(
    <QueryClientProvider client={client}>
      <SyncStatusProvider>
        <InterestsPage onSelectProduct={vi.fn()} />
      </SyncStatusProvider>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: "수정" }));
  await userEvent.clear(screen.getByLabelText("관심 노트"));
  await userEvent.type(screen.getByLabelText("관심 노트"), "내가 작성한 노트");
  act(() => client.setQueryData(["interests"], [refreshed]));
  await screen.findByRole("button", { name: "최신 관심 정보 불러오기" });
  await userEvent.click(screen.getByRole("button", { name: "변경 저장" }));
  expect(await screen.findByText("다른 화면에서 변경했습니다")).toBeInTheDocument();
  expect(interestsApi.update).toHaveBeenCalledWith(
    item.id,
    expect.objectContaining({
      note: "내가 작성한 노트",
      expected_updated_at: item.updated_at,
    }),
  );
  expect(screen.getByLabelText("관심 노트")).toHaveValue("내가 작성한 노트");
  await userEvent.click(screen.getByRole("button", { name: "최신 관심 정보 불러오기" }));
  expect(screen.getByLabelText("관심 노트")).toHaveValue("서버에서 변경한 노트");
});
