import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Product, ProductMetrics } from "@/api/types";
import { SkuMetricsTable } from "@/components/SkuMetricsTable";

function metrics(paid: string | null, purchased: number, stock: number): ProductMetrics {
  return {
    purchased_count: purchased,
    consumed_count: purchased - stock,
    in_stock_count: stock,
    unopened_count: stock,
    opened_count: 0,
    gifted_count: 0,
    sold_count: 0,
    avg_list_price: paid,
    avg_paid_price: paid,
    price_per_100ml: paid === "30000" ? "4000" : paid === "10000" ? "2000" : null,
    price_per_100ml_paid: null,
    list_total: paid,
    paid_total: paid,
    discount_rate: null,
    total_volume_ml: 0,
    inventory_value_at_cost: stock ? paid : "0",
    value_for_money: null,
  };
}
function product(): Product {
  return {
    skus: [
      { id: "s500", volume_ml: 500 },
      { id: "s750", volume_ml: 750 },
      { id: "s350", volume_ml: 350 },
    ],
    sku_summaries: [
      { sku_id: "s500", volume_ml: 500, metrics: metrics("10000", 1, 0) },
      { sku_id: "s750", volume_ml: 750, metrics: metrics("30000", 1, 1) },
      { sku_id: "s350", volume_ml: 350, metrics: metrics(null, 0, 0) },
    ],
  } as Product;
}

describe("SkuMetricsTable", () => {
  it("재고 있는 규격을 먼저 표시하고 과거 구매와 구매 없는 규격을 구분한다", () => {
    render(<SkuMetricsTable product={product()} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("750ml보유 중1병1병0 / 130,000원4,000원");
    expect(rows[2]).toHaveTextContent("350ml구매 기록 없음0병0병");
    expect(rows[2]).not.toHaveTextContent("0원");
    expect(rows[3]).toHaveTextContent("500ml지난 규격1병0병0 / 010,000원2,000원");
  });

  it("규격 선택과 전체 보기에서 실제 SKU ID를 전달한다", async () => {
    const onSelect = vi.fn();
    render(<SkuMetricsTable product={product()} selectedSkuId="s750" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "750ml" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "500ml" }));
    expect(onSelect).toHaveBeenLastCalledWith("s500");
    await userEvent.click(screen.getByRole("button", { name: "전체 규격 보기" }));
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it("여러 규격의 구응답은 혼합 평균을 추정하지 않고 준비 중임을 표시한다", () => {
    const legacy = product();
    delete legacy.sku_summaries;
    render(<SkuMetricsTable product={legacy} />);
    expect(screen.getByText("규격별 정보 준비 중")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("단일 규격에는 별도 선택 표를 추가하지 않는다", () => {
    const single = product();
    single.skus = single.skus.slice(0, 1);
    const { container } = render(<SkuMetricsTable product={single} />);
    expect(container).toBeEmptyDOMElement();
  });
});
