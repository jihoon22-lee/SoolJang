import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatsPage } from "@/pages/StatsPage";
import { db } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";

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

function renderStatsPage() {
  // PivotExplorer(Task 20)가 온라인 전용 조회를 함께 하므로 최소한으로 스텁해 둔다 —
  // 이 파일의 테스트는 통계 v1(랭킹·주종별 집계·합계) 표시만 검증한다.
  stubRoutes([
    { match: "/vendors", method: "GET", body: [] },
    { match: "/saved-views", method: "GET", body: [] },
    { match: "/stats/timeseries", method: "GET", body: [] },
  ]);
  return renderWithQuery(
    <SyncStatusProvider>
      <StatsPage />
    </SyncStatusProvider>,
  );
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
  ]);
});

describe("StatsPage", () => {
  it("빈 컬렉션이면 가격 정보 없음과 안내 문구를 보여준다", async () => {
    renderStatsPage();

    expect(await screen.findByText("등록된 술이 없습니다.")).toBeInTheDocument();
    // null 은 0원이 아니라 "가격 정보 없음"이어야 한다(D35).
    expect(screen.getAllByText("가격 정보 없음").length).toBeGreaterThan(0);
    expect(screen.getAllByText("데이터가 없습니다.").length).toBe(4);
  });

  it("오프라인이면 피벗 대신 안내 문구를 보여준다(Task 20)", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });

    renderWithQuery(
      <SyncStatusProvider>
        <StatsPage />
      </SyncStatusProvider>,
    );

    expect(
      await screen.findByText("커스텀 피벗과 월별 시계열은 온라인일 때만 볼 수 있습니다."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실행" })).not.toBeInTheDocument();
  });

  it("랭킹·주종별 집계·합계를 표시한다", async () => {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주" }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
    ]);
    await db.vendor.bulkPut([
      row({ id: "v1", name: "가상마트1", kind: "mart" }),
      row({ id: "v2", name: "가상마트2", kind: "mart" }),
    ]);
    await db.product.bulkPut([
      row({
        id: "p1",
        name: "글렌고인 25y",
        category_id: "whisky",
        abv: "43.0",
        personal_rating: "3.0",
      }),
      row({
        id: "p2",
        name: "평점 술",
        category_id: "whisky",
        abv: "13.0",
        personal_rating: "5.0",
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
        vendor_id: "v2",
        quantity: 1,
        unit_list_price: "100000",
        unit_paid_price: "90000",
      }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "unopened" }),
    ]);

    renderStatsPage();

    expect(await screen.findByRole("table")).toBeInTheDocument();
    const table = screen.getByRole("table");
    // 위스키의 상위 주종인 "양주" 로 롤업된다.
    expect(within(table).getByText("양주")).toBeInTheDocument();
    expect(within(table).getByText("2")).toBeInTheDocument();

    const summarySection = screen.getByRole("heading", { name: "전체 합계" }).closest("section");
    expect(summarySection).not.toBeNull();
    expect(within(summarySection as HTMLElement).getByText("2병")).toBeInTheDocument();
    expect(within(summarySection as HTMLElement).getByText("2곳")).toBeInTheDocument();
    // 두 제품 모두 랭킹 4종 각각에 나타난다(제품이 2개뿐이라 상위 10건 안에 다 든다).
    expect(screen.getAllByText("글렌고인 25y").length).toBeGreaterThan(0);
    expect(screen.getAllByText("평점 술").length).toBeGreaterThan(0);
    // 평점 랭킹만 5.0점짜리("평점 술")가 1위로 뒤집힌다.
    const ratingSection = screen.getByRole("region", { name: "개인 평점" });
    const [firstEntry] = within(ratingSection).getAllByRole("listitem");
    expect(firstEntry).toHaveTextContent("평점 술");
  });
});
