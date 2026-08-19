import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bottle, Product, ProductMetrics, Purchase } from "@/api/types";
import { ProductDetail } from "@/components/ProductDetail";
import { renderWithQuery, stubRoutes } from "@/testing";

const metrics: ProductMetrics = {
  purchased_count: 3,
  consumed_count: 1,
  in_stock_count: 2,
  unopened_count: 1,
  opened_count: 1,
  gifted_count: 0,
  sold_count: 0,
  avg_list_price: "110000.00",
  avg_paid_price: "102666.67",
  price_per_100ml: "15714.29",
  price_per_100ml_paid: "14666.67",
  list_total: "330000.00",
  paid_total: "308000.00",
  discount_rate: "0.0667",
  total_volume_ml: 2100,
  inventory_value_at_cost: "205333.34",
  value_for_money: "31.85",
};

const product: Product = {
  id: "p1",
  name: "가상 증류소 싱글몰트 12y",
  name_en: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  category_id: "c1",
  category_path: ["양주", "위스키", "싱글몰트 위스키"],
  producer_id: null,
  producer_name: "가상 증류소",
  country: "스코틀랜드",
  region: null,
  abv: "46.00",
  vintage: null,
  age_years: "12.0",
  personal_rating: "5.0",
  note: "바닐라와 꿀",
  varieties: [],
  skus: [{ id: "s1", volume_ml: 700, barcode: null, barcode_type: null, package_note: null }],
  metrics,
};

const purchases: Purchase[] = [
  {
    id: "pu1",
    sku_id: "s1",
    volume_ml: 700,
    vendor_id: "v1",
    vendor_name: "가상마트",
    purchased_on: "2026-03-01",
    quantity: 2,
    unit_list_price: "100000.00",
    unit_paid_price: "90000.00",
    list_total: "200000.00",
    paid_total: "180000.00",
    currency: "KRW",
    fx_rate: null,
    foreign_unit_price: null,
    discount_note: null,
    import_note: null,
    bottle_count: 2,
  },
  {
    id: "pu2",
    sku_id: "s1",
    volume_ml: 700,
    vendor_id: null,
    vendor_name: null,
    purchased_on: null,
    quantity: 1,
    unit_list_price: null,
    unit_paid_price: null,
    list_total: null,
    paid_total: null,
    currency: "KRW",
    fx_rate: null,
    foreign_unit_price: null,
    discount_note: null,
    import_note: "레거시 임포트",
    bottle_count: 1,
  },
];

function setup(overrides: Partial<Parameters<typeof ProductDetail>[0]> = {}) {
  const onBack = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onAddPurchase = vi.fn();
  const onDeletePurchase = vi.fn();
  const onSplitPurchase = vi.fn();
  const onAddSku = vi.fn();
  renderWithQuery(
    <ProductDetail
      product={product}
      purchases={purchases}
      bottles={[]}
      offline={false}
      onBack={onBack}
      onEdit={onEdit}
      onDelete={onDelete}
      deleting={false}
      onAddPurchase={onAddPurchase}
      addingPurchase={false}
      addPurchaseError={null}
      vendorNames={[]}
      onDeletePurchase={onDeletePurchase}
      deletingPurchaseId={null}
      onSplitPurchase={onSplitPurchase}
      splittingPurchaseId={null}
      splitError={null}
      onAddSku={onAddSku}
      addingSku={false}
      {...overrides}
    />,
  );
  return { onBack, onEdit, onDelete, onAddPurchase, onDeletePurchase, onSplitPurchase, onAddSku };
}

describe("ProductDetail", () => {
  it("이름과 주종 경로를 보여준다", () => {
    setup();

    expect(screen.getByRole("heading", { name: /가상 증류소 싱글몰트 12y/ })).toBeInTheDocument();
    expect(screen.getByText(/양주 › 위스키 › 싱글몰트 위스키/)).toBeInTheDocument();
  });

  it("파생 지표를 자동 계산이라고 명시한다", () => {
    // 사용자가 직접 입력해야 하는 값으로 오해하면 엑셀 시절 습관이 이어진다.
    setup();

    expect(screen.getByText(/자동 계산됩니다/)).toBeInTheDocument();
  });

  it("병수와 금액 지표를 표시한다", () => {
    setup();

    expect(screen.getByText("3병")).toBeInTheDocument();
    expect(screen.getByText("2병")).toBeInTheDocument();
    expect(screen.getByText("110,000원")).toBeInTheDocument();
    expect(screen.getByText("102,667원")).toBeInTheDocument();
  });

  it("100ml당 가격이 정가 기준임을 알린다", () => {
    // 실구매 기준으로 오해하면 레거시 통계와 어긋난 값으로 판단하게 된다.
    setup();

    expect(screen.getByText(/정가 기준/)).toBeInTheDocument();
  });

  it("할인율을 백분율로 보여준다", () => {
    setup();

    expect(screen.getByText("6.7%")).toBeInTheDocument();
  });

  it("구매 이력을 구매처·가격과 함께 보여준다", () => {
    // 같은 술을 다른 곳에서 다른 가격에 산 이력이 각각 남는 것이 핵심이다.
    setup();

    const table = screen.getByRole("table");
    expect(within(table).getByText("가상마트")).toBeInTheDocument();
    expect(within(table).getByText("2026-03-01")).toBeInTheDocument();
    expect(within(table).getByText("90,000원")).toBeInTheDocument();
  });

  it("구매일이 없으면 미기록임을 알린다", () => {
    setup();

    expect(screen.getByText("날짜 미기록")).toBeInTheDocument();
    expect(screen.getByText("미기록")).toBeInTheDocument();
  });

  it("가격 정보가 없는 구매 건은 0원으로 표시하지 않는다", () => {
    setup();

    const table = screen.getByRole("table");
    // 짧은 표기(대시)를 쓰고 0원을 만들지 않는다.
    expect(within(table).queryByText("0원")).not.toBeInTheDocument();
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("구매 기록이 없으면 구매 건 분리를 안내한다", () => {
    setup({ purchases: [] });

    // 병 섹션도 비어 있으면 같은 role("status")의 안내를 띄운다 — 텍스트로 구분한다.
    expect(screen.getByText(/구매 건을 각각 추가/)).toBeInTheDocument();
  });

  it("목록으로 돌아간다", async () => {
    const { onBack } = setup();

    await userEvent.click(screen.getByRole("button", { name: "← 목록으로" }));

    expect(onBack).toHaveBeenCalled();
  });

  it("삭제를 알린다", async () => {
    const { onDelete } = setup();

    // 구매 행에도 "삭제" 버튼이 있다 — 맨 위(제품 자체) 버튼이 DOM 순서상 항상 먼저다.
    await userEvent.click(screen.getAllByRole("button", { name: "삭제" })[0] as Element);

    expect(onDelete).toHaveBeenCalled();
  });

  it("삭제 중에는 버튼을 막는다", () => {
    setup({ deleting: true });

    expect(screen.getByRole("button", { name: "삭제 중…" })).toBeDisabled();
  });

  it("수정 버튼을 누르면 알린다", async () => {
    const { onEdit } = setup();

    await userEvent.click(screen.getByRole("button", { name: "수정" }));

    expect(onEdit).toHaveBeenCalled();
  });

  describe("병 섹션", () => {
    const bottles: Bottle[] = [
      {
        id: "b1",
        purchase_id: "pu1",
        label_no: 1,
        status: "unopened",
        opened_on: null,
        finished_on: null,
        remaining_ml: null,
        storage_location: null,
        note: null,
      },
      {
        id: "b2",
        purchase_id: "pu1",
        label_no: 2,
        status: "finished",
        opened_on: "2026-02-01",
        finished_on: "2026-02-10",
        remaining_ml: 0,
        storage_location: null,
        note: null,
      },
    ];

    it("병이 없으면 안내한다", () => {
      setup({ bottles: [] });

      expect(screen.getByText(/등록된 병이 없습니다/)).toBeInTheDocument();
    });

    it("병 목록을 보여주고, 재고(미개봉·개봉)를 먼저 보여준다", () => {
      setup({ bottles });

      expect(screen.getByText("병 (2개)")).toBeInTheDocument();
      const labels = screen.getAllByText(/\d번 병/).map((el) => el.textContent);
      expect(labels).toEqual(["1번 병", "2번 병"]);
    });

    it("병을 누르면 펼쳐져 상세 패널이 나온다", async () => {
      setup({ bottles });

      await userEvent.click(screen.getByRole("button", { name: /1번 병/ }));

      expect(screen.getByText("개봉일")).toBeInTheDocument();
    });
  });

  describe("구매 관리", () => {
    it("오프라인이면 구매 추가·삭제·분할 버튼을 숨긴다", () => {
      setup({ offline: true });

      expect(screen.queryByRole("button", { name: "구매 추가" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "분할" })).not.toBeInTheDocument();
      // 제품 자체의 "삭제" 버튼(항상 보임)만 남고, 구매 행별 "삭제" 버튼은 없다.
      expect(screen.getAllByRole("button", { name: "삭제" })).toHaveLength(1);
      expect(
        screen.getByText("구매 추가·삭제·분할은 온라인일 때만 할 수 있습니다."),
      ).toBeInTheDocument();
    });

    it("구매 추가 폼을 열고 제출하면 입력값을 그대로 넘긴다", async () => {
      const { onAddPurchase } = setup();

      await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));
      await userEvent.clear(screen.getByLabelText("병수"));
      await userEvent.type(screen.getByLabelText("병수"), "3");
      await userEvent.type(screen.getByLabelText("구매처"), "새 구매처");
      await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));

      expect(onAddPurchase).toHaveBeenCalledWith(
        expect.objectContaining({ skuId: "s1", quantity: 3, vendorName: "새 구매처" }),
      );
    });

    it("구매처 자동완성 후보를 보여준다", async () => {
      setup({ vendorNames: ["이마트", "이마트 트레이더스", "코스트코"] });

      await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));
      await userEvent.type(screen.getByLabelText("구매처"), "이마트");

      const options = within(screen.getByRole("listbox")).getAllByRole("option");
      expect(options.map((o) => o.textContent)).toEqual(["이마트", "이마트 트레이더스"]);
    });

    it("구매처는 직전에 쓴 값으로 미리 채워진다", async () => {
      window.localStorage.setItem("sooljang:last-vendor-name", "이마트");

      setup();
      await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));

      expect(screen.getByLabelText("구매처")).toHaveValue("이마트");
      window.localStorage.clear();
    });

    it("구매 건 삭제는 확인을 받은 뒤에만 호출한다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const { onDeletePurchase } = setup();

      // index 0 은 제품 자체의 "삭제" 버튼 — 구매 행(pu1)의 삭제는 index 1 이다.
      await userEvent.click(screen.getAllByRole("button", { name: "삭제" })[1] as Element);
      expect(onDeletePurchase).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      await userEvent.click(screen.getAllByRole("button", { name: "삭제" })[1] as Element);
      expect(onDeletePurchase).toHaveBeenCalledWith("pu1");

      confirmSpy.mockRestore();
    });

    it("병수가 1개인 구매 건은 분할 버튼이 없다", () => {
      setup();

      // purchases: pu1(quantity 2), pu2(quantity 1) — 분할 버튼은 pu1 행에만 있어야 한다.
      expect(screen.getAllByRole("button", { name: "분할" })).toHaveLength(1);
    });

    it("분할 폼을 열고 병수 합이 안 맞으면 에러를 보여준다", async () => {
      const { onSplitPurchase } = setup();

      await userEvent.click(screen.getAllByRole("button", { name: "분할" })[0] as Element);
      const quantityInputs = screen.getAllByLabelText("병수");
      // 첫 입력은 "구매 추가" 폼이 닫혀 있으므로 분할 폼의 두 병수 입력만 있다.
      await userEvent.clear(quantityInputs[0] as Element);
      await userEvent.type(quantityInputs[0] as Element, "5");

      await userEvent.click(screen.getByRole("button", { name: "분할 실행" }));

      expect(screen.getByRole("alert")).toHaveTextContent("병수 합이");
      expect(onSplitPurchase).not.toHaveBeenCalled();
    });

    it("분할 폼 제출이 성공하면 콜백을 호출한다", async () => {
      const { onSplitPurchase } = setup();

      await userEvent.click(screen.getAllByRole("button", { name: "분할" })[0] as Element);
      await userEvent.click(screen.getByRole("button", { name: "분할 실행" }));

      expect(onSplitPurchase).toHaveBeenCalledWith("pu1", [
        { quantity: "1", vendorName: "" },
        { quantity: "1", vendorName: "" },
      ]);
    });

    it("규격이 없는 제품은 구매 추가 대신 규격 추가 폼을 보여준다", async () => {
      const { onAddSku } = setup({
        product: { ...product, skus: [] },
      });

      await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));
      expect(screen.getByText(/먼저 규격을 등록하세요/)).toBeInTheDocument();

      await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
      await userEvent.click(screen.getByRole("button", { name: "규격 추가" }));

      expect(onAddSku).toHaveBeenCalledWith(700);
    });
  });

  describe("외부 정보", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("버튼을 누르기 전에는 조회하지 않는다", () => {
      const { spy } = stubRoutes([{ match: "/external-lookup", method: "POST", body: [] }]);

      setup();

      expect(spy).not.toHaveBeenCalled();
    });

    it("버튼을 누르면 조회 결과를 보여준다", async () => {
      stubRoutes([
        {
          match: "/external-lookup",
          method: "POST",
          body: [
            {
              source_id: "src-1",
              source_name: "데일리샷",
              cached: false,
              source_url: "https://example.com/product/1",
              fields: { price: 35000, rating: 4.5 },
              raw_excerpt: null,
              degraded: false,
              warning: null,
              fetched_at: "2026-08-01T00:00:00Z",
              matched_name: "글렌알라키 12년",
              match_score: 0.95,
              needs_confirmation: false,
              pinned: false,
              candidates: [],
            },
          ],
        },
      ]);

      setup();
      await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

      expect(await screen.findByText("데일리샷")).toBeInTheDocument();
      expect(screen.getByText("35000")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "출처 보기" })).toHaveAttribute(
        "href",
        "https://example.com/product/1",
      );
    });

    it("degraded 결과는 경고와 함께 보여준다", async () => {
      stubRoutes([
        {
          match: "/external-lookup",
          method: "POST",
          body: [
            {
              source_id: "src-1",
              source_name: "데일리샷",
              cached: false,
              source_url: null,
              fields: {},
              raw_excerpt: null,
              degraded: true,
              warning: "검색 결과에서 후보를 찾지 못했습니다",
              fetched_at: "2026-08-01T00:00:00Z",
              matched_name: null,
              match_score: null,
              needs_confirmation: false,
              pinned: false,
              candidates: [],
            },
          ],
        },
      ]);

      setup();
      await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

      expect(await screen.findByText("일부 정보만 확인됨")).toBeInTheDocument();
      expect(screen.getByText("검색 결과에서 후보를 찾지 못했습니다")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "출처 보기" })).not.toBeInTheDocument();
    });

    it("등록된 소스가 없으면 안내한다", async () => {
      stubRoutes([{ match: "/external-lookup", method: "POST", body: [] }]);

      setup();
      await userEvent.click(screen.getByRole("button", { name: "외부 정보 조회" }));

      expect(await screen.findByText(/등록된 외부 소스가 없습니다/)).toBeInTheDocument();
    });

    it("오프라인이면 조회 버튼을 비활성화한다", () => {
      setup({ offline: true });

      expect(screen.getByRole("button", { name: "외부 정보 조회" })).toBeDisabled();
      expect(
        screen.getByText("외부 정보 조회는 온라인일 때만 할 수 있습니다."),
      ).toBeInTheDocument();
    });
  });
});
