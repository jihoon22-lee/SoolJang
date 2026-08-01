import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CategoryStat, Rankings, StatsSummary } from "@/api/types";
import { StatsPage } from "@/pages/StatsPage";
import { renderWithQuery, stubRoutes } from "@/testing";

const emptyRankings: Rankings = {
  by_bottle_price: [],
  by_total_spend: [],
  by_price_per_100ml: [],
  by_personal_rating: [],
};

const zeroSummary: StatsSummary = {
  purchased_count: 0,
  consumed_count: 0,
  in_stock_count: 0,
  unopened_count: 0,
  opened_count: 0,
  total_volume_ml: 0,
  list_total: null,
  paid_total: null,
  avg_list_price: null,
  avg_paid_price: null,
  avg_price_per_100ml: null,
  discount_rate: null,
  avg_personal_rating: null,
  vendor_count: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StatsPage", () => {
  it("빈 컬렉션이면 가격 정보 없음과 안내 문구를 보여준다", async () => {
    stubRoutes([
      { match: "/stats/rankings", body: emptyRankings },
      { match: "/stats/by-category", body: [] },
      { match: "/stats/summary", body: zeroSummary },
    ]);

    renderWithQuery(<StatsPage />);

    expect(await screen.findByText("등록된 술이 없습니다.")).toBeInTheDocument();
    // null 은 0원이 아니라 "가격 정보 없음"이어야 한다(D35).
    expect(screen.getAllByText("가격 정보 없음").length).toBeGreaterThan(0);
    expect(screen.getAllByText("데이터가 없습니다.").length).toBe(4);
  });

  it("랭킹·주종별 집계·합계를 표시한다", async () => {
    const rankings: Rankings = {
      by_bottle_price: [{ product_id: "p1", product_name: "글렌고인 25y", value: "848000.00" }],
      by_total_spend: [{ product_id: "p1", product_name: "글렌고인 25y", value: "848000.00" }],
      by_price_per_100ml: [{ product_id: "p1", product_name: "글렌고인 25y", value: "154286.00" }],
      by_personal_rating: [{ product_id: "p2", product_name: "평점 술", value: "5.0" }],
    };
    const categories: CategoryStat[] = [
      {
        category_id: "whisky",
        name: "양주",
        bottle_count: 134,
        total_spend: "1080000.00",
        avg_abv: "43.0",
        avg_rating: "4.0",
        avg_price_per_100ml: "20000.00",
        discount_rate: "0.1000",
      },
    ];
    const summary: StatsSummary = {
      ...zeroSummary,
      purchased_count: 1078,
      consumed_count: 819,
      in_stock_count: 259,
      unopened_count: 225,
      opened_count: 34,
      total_volume_ml: 704970,
      list_total: "42401108.00",
      paid_total: "36495454.00",
      avg_list_price: "39333.00",
      avg_paid_price: "33855.00",
      avg_price_per_100ml: "6015.00",
      discount_rate: "0.1400",
      avg_personal_rating: "3.4",
      vendor_count: 82,
    };

    stubRoutes([
      { match: "/stats/rankings", body: rankings },
      { match: "/stats/by-category", body: categories },
      { match: "/stats/summary", body: summary },
    ]);

    renderWithQuery(<StatsPage />);

    expect(await screen.findByRole("table")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("양주")).toBeInTheDocument();
    expect(within(table).getByText("134")).toBeInTheDocument();

    expect(screen.getByText("1,078병")).toBeInTheDocument();
    expect(screen.getByText("82곳")).toBeInTheDocument();
    expect(screen.getAllByText("글렌고인 25y").length).toBeGreaterThan(0);
    expect(screen.getByText("평점 술")).toBeInTheDocument();
  });

  it("통계를 불러오지 못하면 오류를 보여준다", async () => {
    stubRoutes([]);

    renderWithQuery(<StatsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("통계를 불러올 수 없습니다");
  });
});
