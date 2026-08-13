import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomePage } from "@/pages/HomePage";
import { db } from "@/sync/db";
import { renderWithQuery } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    user_id: "u1",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function renderHomePage() {
  const onSelectProduct = vi.fn();
  const onSelectCategory = vi.fn();
  renderWithQuery(
    <HomePage onSelectProduct={onSelectProduct} onSelectCategory={onSelectCategory} />,
  );
  return { onSelectProduct, onSelectCategory };
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([
    db.category.clear(),
    db.product.clear(),
    db.sku.clear(),
    db.purchase.clear(),
    db.bottle.clear(),
    db.vendor.clear(),
    db.tasting_session.clear(),
  ]);
});

describe("HomePage", () => {
  it("빈 컬렉션이면 안내 문구를 보여준다", async () => {
    renderHomePage();

    expect(await screen.findByText("등록된 술이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("아직 등록한 술이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("아직 시음 기록이 없습니다.")).toBeInTheDocument();
  });

  it("요약·주종별 보유·랭킹·최근 활동을 보여준다", async () => {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주" }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
    ]);
    await db.vendor.bulkPut([row({ id: "v1", name: "가상마트", kind: "mart" })]);
    await db.product.bulkPut([
      row({
        id: "p1",
        name: "글렌고인 25y",
        category_id: "whisky",
        abv: "43.0",
        personal_rating: "3.0",
        created_at: "2026-01-02T00:00:00Z",
      }),
      row({
        id: "p2",
        name: "평점 술",
        category_id: "whisky",
        abv: "13.0",
        personal_rating: "5.0",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 500 }),
      row({ id: "s2", product_id: "p2", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({
        id: "pu1",
        sku_id: "s1",
        vendor_id: "v1",
        quantity: 1,
        unit_list_price: "1000000",
        unit_paid_price: "848000",
      }),
      row({
        id: "pu2",
        sku_id: "s2",
        vendor_id: "v1",
        quantity: 1,
        unit_list_price: "100000",
        unit_paid_price: "90000",
      }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "unopened" }),
    ]);
    await db.tasting_session.bulkPut([
      row({ id: "t1", sku_id: "s1", bottle_id: "b1", tasted_on: "2026-01-05", rating: "4.5" }),
    ]);

    renderHomePage();

    // 요약: 구매 병수·재고가 "2병" 으로 표시된다(여러 곳에 나타날 수 있다).
    expect((await screen.findAllByText("2병")).length).toBeGreaterThan(0);
    // 주종별 보유: 상위 주종("양주")으로 롤업.
    expect(screen.getByText("양주")).toBeInTheDocument();
    // 랭킹·최근 등록·최근 시음 어디서든 제품 이름이 보인다.
    expect(screen.getAllByText("글렌고인 25y").length).toBeGreaterThan(0);
  });
});
