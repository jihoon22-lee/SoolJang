import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Product, ProductMetrics } from "@/api/types";
import { ProductList } from "@/components/ProductList";

const emptyMetrics: ProductMetrics = {
  purchased_count: 0,
  consumed_count: 0,
  in_stock_count: 0,
  unopened_count: 0,
  opened_count: 0,
  gifted_count: 0,
  sold_count: 0,
  avg_list_price: null,
  avg_paid_price: null,
  price_per_100ml: null,
  price_per_100ml_paid: null,
  list_total: null,
  paid_total: null,
  discount_rate: null,
  total_volume_ml: 0,
  inventory_value_at_cost: null,
  value_for_money: null,
};

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    name: "글렌알라키 14y",
    name_en: null,
    category_id: "c1",
    category_path: ["양주", "위스키", "싱글몰트 위스키"],
    producer_id: null,
    producer_name: null,
    country: null,
    region: null,
    abv: "46.00",
    vintage: null,
    age_years: null,
    personal_rating: "4.5",
    note: null,
    varieties: [],
    skus: [{ id: "s1", volume_ml: 700, barcode: null, barcode_type: null, package_note: null }],
    metrics: { ...emptyMetrics },
    ...overrides,
  };
}

describe("ProductList", () => {
  it("빈 목록에서 다음 행동을 안내한다", () => {
    render(<ProductList products={[]} onSelect={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("조건에 맞는 술이 없습니다");
  });

  it("테이블과 카드 두 뷰에 같은 데이터를 렌더한다", () => {
    // CSS 로 하나만 보이게 한다. JS 뷰포트 감지를 쓰지 않으므로 두 뷰가 항상 DOM 에 있다.
    render(<ProductList products={[product()]} onSelect={vi.fn()} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /카드 보기/ })).toBeInTheDocument();
    // 같은 제품 이름이 두 뷰에 각각 있다.
    expect(screen.getAllByRole("button", { name: "글렌알라키 14y" })).toHaveLength(2);
  });

  it("가격 정보가 없으면 0원이 아니라 없음으로 표시한다", () => {
    render(<ProductList products={[product()]} onSelect={vi.fn()} />);

    const cards = screen.getByRole("list", { name: /카드 보기/ });
    expect(within(cards).getAllByText("가격 정보 없음").length).toBeGreaterThan(0);
    expect(within(cards).queryByText("0원")).not.toBeInTheDocument();
  });

  it("가격이 있으면 천 단위 구분과 함께 표시한다", () => {
    const withPrice = product({
      metrics: { ...emptyMetrics, avg_list_price: "150000.00", price_per_100ml: "21428.57" },
    });

    render(<ProductList products={[withPrice]} onSelect={vi.fn()} />);

    const cards = screen.getByRole("list", { name: /카드 보기/ });
    expect(within(cards).getByText("150,000원")).toBeInTheDocument();
    expect(within(cards).getByText("21,429원")).toBeInTheDocument();
  });

  it("재고 유무를 배지로 구분한다", () => {
    const inStock = product({ metrics: { ...emptyMetrics, in_stock_count: 3 } });

    const { unmount } = render(<ProductList products={[inStock]} onSelect={vi.fn()} />);
    expect(screen.getAllByText("재고 3병").length).toBeGreaterThan(0);
    unmount();

    render(<ProductList products={[product()]} onSelect={vi.fn()} />);
    expect(screen.getAllByText("재고 없음").length).toBeGreaterThan(0);
  });

  it("주종 계층 경로를 보여준다", () => {
    render(<ProductList products={[product()]} onSelect={vi.fn()} />);

    expect(screen.getAllByText(/양주 › 위스키 › 싱글몰트 위스키/).length).toBeGreaterThan(0);
  });

  it("빈티지가 있으면 이름 옆에 표시한다", () => {
    render(<ProductList products={[product({ vintage: 2019 })]} onSelect={vi.fn()} />);

    expect(screen.getAllByText(/2019/).length).toBeGreaterThan(0);
  });

  it("이름을 선택하면 상세로 이동한다", async () => {
    const onSelect = vi.fn();
    render(<ProductList products={[product()]} onSelect={onSelect} />);

    await userEvent.click(screen.getAllByRole("button", { name: "글렌알라키 14y" })[0] as Element);

    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("키보드로 제품을 선택할 수 있다", async () => {
    const onSelect = vi.fn();
    render(<ProductList products={[product()]} onSelect={onSelect} />);

    await userEvent.tab();
    await userEvent.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("테이블에 스크린리더용 설명을 붙인다", () => {
    render(<ProductList products={[product()]} onSelect={vi.fn()} />);

    expect(screen.getByRole("table")).toHaveAccessibleName(/제품 목록/);
  });
});
