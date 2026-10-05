/**
 * 직전 구매처 미리 채우기. 구매처 기억은 계정별이라 로컬 저장소 소유자를 활성화해야 한다 —
 * 전역 `db` 를 바꾸므로 다른 컴포넌트 테스트와 섞이지 않게 파일을 나눈다.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Product, ProductMetrics, Purchase } from "@/api/types";
import { ProductDetail } from "@/components/ProductDetail";
import { ProductForm } from "@/components/ProductForm";
import { setLastVendorName } from "@/lastVendor";
import { activateDatabase } from "@/sync/db";
import { renderWithQuery } from "@/testing";

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

beforeEach(async () => {
  window.localStorage.clear();
  await activateDatabase("u1");
  setLastVendorName("이마트");
});

describe("직전 구매처 미리 채우기", () => {
  it("새 술 등록 폼의 구매처를 미리 채운다", () => {
    render(
      <ProductForm
        categories={[]}
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("구매처")).toHaveValue("이마트");
  });

  it("구매 추가 폼의 구매처를 미리 채우고, 다른 계정에서는 비운다", async () => {
    const props = {
      product,
      purchases,
      bottles: [],
      offline: false,
      onBack: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      deleting: false,
      onAddPurchase: vi.fn(),
      addingPurchase: false,
      addPurchaseError: null,
      vendorNames: [],
      onDeletePurchase: vi.fn(),
      deletingPurchaseId: null,
      onSplitPurchase: vi.fn(),
      splittingPurchaseId: null,
      splitError: null,
      onAddSku: vi.fn(),
      addingSku: false,
    };
    const { unmount } = renderWithQuery(<ProductDetail {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));
    expect(screen.getByLabelText("구매처")).toHaveValue("이마트");
    unmount();

    // u1 의 기억은 저장소에 그대로 남아 있지만 u2 의 폼에는 채워지지 않아야 한다.
    await activateDatabase("u2");
    render(
      <ProductForm
        categories={[]}
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("구매처")).toHaveValue("");
  });
});
