import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Product, ProductMetrics, Purchase } from "@/api/types";
import { ProductDetail } from "@/components/ProductDetail";

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
  const onDelete = vi.fn();
  render(
    <ProductDetail
      product={product}
      purchases={purchases}
      onBack={onBack}
      onDelete={onDelete}
      deleting={false}
      {...overrides}
    />,
  );
  return { onBack, onDelete };
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

    expect(screen.getByRole("status")).toHaveTextContent("구매 건을 각각 추가");
  });

  it("목록으로 돌아간다", async () => {
    const { onBack } = setup();

    await userEvent.click(screen.getByRole("button", { name: "← 목록으로" }));

    expect(onBack).toHaveBeenCalled();
  });

  it("삭제를 알린다", async () => {
    const { onDelete } = setup();

    await userEvent.click(screen.getByRole("button", { name: "삭제" }));

    expect(onDelete).toHaveBeenCalled();
  });

  it("삭제 중에는 버튼을 막는다", () => {
    setup({ deleting: true });

    expect(screen.getByRole("button", { name: "삭제 중…" })).toBeDisabled();
  });
});
