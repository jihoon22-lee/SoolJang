import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Bottle, Product, Purchase } from "@/api/types";
import { SkuMetricsTable } from "@/components/SkuMetricsTable";
import { renderWithQuery } from "@/testing";

function purchase(id: string, skuId: string, quantity: number, paid: string): Purchase {
  return {
    id,
    sku_id: skuId,
    volume_ml: null,
    vendor_id: null,
    vendor_name: null,
    purchased_on: null,
    quantity,
    unit_list_price: paid,
    unit_paid_price: paid,
    list_total: null,
    paid_total: null,
    currency: "KRW",
    fx_rate: null,
    foreign_unit_price: null,
    discount_note: null,
    import_note: null,
    bottle_count: quantity,
  };
}

const bottle = (id: string, purchaseId: string, status: Bottle["status"]): Bottle => ({
  id,
  purchase_id: purchaseId,
  label_no: 1,
  status,
  opened_on: null,
  finished_on: null,
  remaining_ml: null,
  storage_location: null,
  note: null,
});

describe("SkuMetricsTable", () => {
  it("용량별로 병당·100ml당 가격과 재고를 따로 계산하고, 용량이 하나면 숨긴다", () => {
    const product = {
      skus: [
        { id: "s375", volume_ml: 375 },
        { id: "s750", volume_ml: 750 },
      ],
    } as unknown as Product;
    renderWithQuery(
      <SkuMetricsTable
        product={product}
        purchases={[purchase("p1", "s375", 2, "15000"), purchase("p2", "s750", 1, "30000")]}
        bottles={[
          bottle("b1", "p1", "unopened"),
          bottle("b2", "p1", "finished"),
          bottle("b3", "p2", "open"),
        ]}
      />,
    );

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("375ml2병1병15,000원4,000원");
    expect(rows[2]).toHaveTextContent("750ml1병1병30,000원4,000원");

    const { container } = renderWithQuery(
      <SkuMetricsTable
        product={{ skus: [{ id: "s1", volume_ml: 700 }] } as unknown as Product}
        purchases={[]}
        bottles={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
