import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  const onSelectProduct = vi.fn();
  const onSelectCategory = vi.fn();
  const result = renderWithQuery(
    <SyncStatusProvider>
      <StatsPage onSelectProduct={onSelectProduct} onSelectCategory={onSelectCategory} />
    </SyncStatusProvider>,
  );
  return { ...result, onSelectProduct, onSelectCategory };
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
    // 랭킹 5종(가성비 포함) + 병 상태 도넛 차트, 총 6곳이 빈 상태 문구를 보여준다.
    // 주종별 집계 차트는 "등록된 술이 없습니다." 문구로 대체돼 따로 세지 않는다.
    expect(screen.getAllByText("데이터가 없습니다.").length).toBe(6);
  });

  it("오프라인이면 피벗 대신 안내 문구를 보여준다(Task 20)", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });

    renderWithQuery(
      <SyncStatusProvider>
        <StatsPage onSelectProduct={vi.fn()} onSelectCategory={vi.fn()} />
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

    const table = await screen.findByRole("table", { name: /주종별 통계 표/ });
    // 위스키의 상위 주종인 "양주" 로 롤업된다.
    expect(within(table).getByText("양주")).toBeInTheDocument();
    expect(within(table).getByText("2")).toBeInTheDocument();

    const summarySection = screen.getByRole("heading", { name: "전체 합계" }).closest("section");
    expect(summarySection).not.toBeNull();
    // "2병" 은 병 상태 도넛 차트의 "미개봉" 항목에도 나타나므로(두 병 다 미개봉) 지표
    // 그리드로 좁혀서 확인한다.
    const metricsGrid = (summarySection as HTMLElement).querySelector(".metrics-grid");
    expect(within(metricsGrid as HTMLElement).getByText("2병")).toBeInTheDocument();
    expect(within(metricsGrid as HTMLElement).getByText("2곳")).toBeInTheDocument();
    // 두 제품 모두 랭킹 5종 각각에 나타난다(제품이 2개뿐이라 상위 10건 안에 다 든다).
    expect(screen.getAllByText("글렌고인 25y").length).toBeGreaterThan(0);
    expect(screen.getAllByText("평점 술").length).toBeGreaterThan(0);
    // 평점 랭킹만 5.0점짜리("평점 술")가 1위로 뒤집힌다.
    const ratingSection = screen.getByRole("region", { name: "개인 평점" });
    const [firstEntry] = within(ratingSection).getAllByRole("listitem");
    expect(firstEntry).toHaveTextContent("평점 술");
  });

  it("주종별 집계 차트의 측정값을 바꾸면 차트가 다시 그려진다(항목 4)", async () => {
    await db.category.bulkPut([row({ id: "liquor", parent_id: null, name: "양주" })]);
    await db.product.bulkPut([
      row({ id: "p1", name: "글렌고인 25y", category_id: "liquor", abv: "43.0" }),
    ]);
    await db.sku.bulkPut([row({ id: "s1", product_id: "p1", volume_ml: 500 })]);
    await db.purchase.bulkPut([
      row({ id: "pu1", sku_id: "s1", quantity: 1, unit_list_price: "100000" }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
    ]);
    renderStatsPage();

    expect(await screen.findByRole("img", { name: "주종별 병수" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("측정값"), "평균 도수");

    expect(await screen.findByRole("img", { name: "주종별 평균 도수" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "주종별 병수" })).not.toBeInTheDocument();
  });

  it("증여·판매 병수, 개봉→소진 일수, 가성비를 전체 합계에 보여준다", async () => {
    await db.product.bulkPut([
      row({ id: "p1", name: "글렌고인 25y", category_id: null, personal_rating: "5.0" }),
    ]);
    await db.sku.bulkPut([row({ id: "s1", product_id: "p1", volume_ml: 500 })]);
    await db.purchase.bulkPut([
      row({ id: "pu1", sku_id: "s1", quantity: 1, unit_list_price: "100000" }),
    ]);
    await db.bottle.bulkPut([
      row({
        id: "b1",
        purchase_id: "pu1",
        label_no: 1,
        status: "finished",
        opened_on: "2026-01-01",
        finished_on: "2026-01-10",
        remaining_ml: 0,
      }),
    ]);
    renderStatsPage();

    const summarySection = (await screen.findByRole("heading", { name: "전체 합계" })).closest(
      "section",
    ) as HTMLElement;
    const metricsGrid = summarySection.querySelector(".metrics-grid") as HTMLElement;

    function metricValue(label: string): string | null | undefined {
      return within(metricsGrid).getByText(label, { selector: "dt" }).nextElementSibling
        ?.textContent;
    }

    // 유일한 병이 "finished" 상태라 미개봉/개봉도 우연히 같은 "0 / 0병" 이 된다 — 라벨로
    // 각 지표를 정확히 짚어서 확인한다.
    expect(metricValue("증여 / 판매")).toBe("0 / 0병");
    expect(metricValue("평균 개봉→소진 일수")).toBe("9일");
    // 가성비 = 5 * 1000 / (100000*100/500) = 5*1000/20000 = 0.25
    expect(metricValue("평균 가성비")).toBe("0.25");
  });

  describe("크로스 링크", () => {
    async function seedTwoCategories() {
      await db.category.bulkPut([
        row({ id: "liquor", parent_id: null, name: "양주" }),
        row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
        row({ id: "beer", parent_id: null, name: "맥주" }),
      ]);
      await db.product.bulkPut([
        row({ id: "p1", name: "글렌고인 25y", category_id: "whisky", personal_rating: "3.0" }),
        row({ id: "p2", name: "무명 맥주", category_id: "beer", personal_rating: null }),
        row({ id: "p3", name: "미분류 술", category_id: null, personal_rating: null }),
      ]);
      await db.sku.bulkPut([
        row({ id: "s1", product_id: "p1", volume_ml: 500 }),
        row({ id: "s2", product_id: "p2", volume_ml: 500 }),
        row({ id: "s3", product_id: "p3", volume_ml: 500 }),
      ]);
      await db.purchase.bulkPut([
        row({ id: "pu1", sku_id: "s1", quantity: 1 }),
        row({ id: "pu2", sku_id: "s2", quantity: 1 }),
        row({ id: "pu3", sku_id: "s3", quantity: 1 }),
      ]);
      await db.bottle.bulkPut([
        row({ id: "b1a", purchase_id: "pu1", label_no: 1, status: "unopened" }),
        row({ id: "b1b", purchase_id: "pu1", label_no: 2, status: "unopened" }),
        row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "unopened" }),
        row({ id: "b3", purchase_id: "pu3", label_no: 1, status: "unopened" }),
      ]);
    }

    it("랭킹의 술 이름을 누르면 그 제품으로 이동한다", async () => {
      await seedTwoCategories();
      const { onSelectProduct } = renderStatsPage();

      const ratingSection = await screen.findByRole("region", { name: "개인 평점" });
      await userEvent.click(within(ratingSection).getByRole("button", { name: "글렌고인 25y" }));

      expect(onSelectProduct).toHaveBeenCalledWith("p1");
    });

    it("주종 행을 누르면 최상위 주종 필터로 이동한다", async () => {
      await seedTwoCategories();
      const { onSelectCategory } = renderStatsPage();

      const table = await screen.findByRole("table", { name: /주종별 통계 표/ });
      // "위스키" 는 "양주" 의 하위 주종이라 최상위인 "양주"(liquor) 로 롤업된다.
      await userEvent.click(within(table).getByRole("button", { name: "양주" }));

      expect(onSelectCategory).toHaveBeenCalledWith("liquor");
    });

    it("미분류 행은 이동할 곳이 없어 클릭할 수 없다", async () => {
      await seedTwoCategories();
      renderStatsPage();

      const table = await screen.findByRole("table", { name: /주종별 통계 표/ });
      expect(within(table).getByText("미분류")).toBeInTheDocument();
      expect(within(table).queryByRole("button", { name: "미분류" })).not.toBeInTheDocument();
    });
  });

  describe("주종별 집계 정렬", () => {
    async function seedSortableCategories() {
      await db.category.bulkPut([
        row({ id: "liquor", parent_id: null, name: "양주" }),
        row({ id: "beer", parent_id: null, name: "맥주" }),
      ]);
      await db.product.bulkPut([
        row({ id: "p1", name: "술1", category_id: "liquor" }),
        row({ id: "p2", name: "술2", category_id: "liquor" }),
        row({ id: "p3", name: "술3", category_id: "beer" }),
      ]);
      await db.sku.bulkPut([
        row({ id: "s1", product_id: "p1", volume_ml: 500 }),
        row({ id: "s2", product_id: "p2", volume_ml: 500 }),
        row({ id: "s3", product_id: "p3", volume_ml: 500 }),
      ]);
      await db.purchase.bulkPut([
        row({ id: "pu1", sku_id: "s1", quantity: 1 }),
        row({ id: "pu2", sku_id: "s2", quantity: 1 }),
        row({ id: "pu3", sku_id: "s3", quantity: 1 }),
      ]);
      await db.bottle.bulkPut([
        row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
        row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "unopened" }),
        row({ id: "b3", purchase_id: "pu3", label_no: 1, status: "unopened" }),
      ]);
    }

    function categoryRowNames(table: HTMLElement): (string | null)[] {
      return within(table)
        .getAllByRole("row")
        .slice(1) // 헤더 행 제외
        .map((tr) => tr.querySelector("th")?.textContent ?? null);
    }

    it("기본 정렬은 병수 내림차순이다", async () => {
      await seedSortableCategories();
      renderStatsPage();

      const table = await screen.findByRole("table", { name: /주종별 통계 표/ });
      // 양주(2병)가 맥주(1병)보다 먼저 온다.
      expect(categoryRowNames(table)).toEqual(["양주", "맥주"]);
    });

    it("주종 헤더를 누르면 이름순으로 바뀌고, 막대 그래프도 같은 순서를 따른다", async () => {
      await seedSortableCategories();
      renderStatsPage();

      const table = await screen.findByRole("table", { name: /주종별 통계 표/ });
      const nameHeader = screen.getByRole("columnheader", { name: /주종/ });
      await userEvent.click(within(nameHeader).getByRole("button"));

      // 이름 오름차순: "맥주" 가 "양주" 보다 먼저다.
      expect(categoryRowNames(table)).toEqual(["맥주", "양주"]);
      const barLabels = screen
        .getAllByText(/양주|맥주/, {
          selector: "button.bar-chart-label, span.bar-chart-label",
        })
        .map((el) => el.textContent);
      expect(barLabels).toEqual(["맥주", "양주"]);
    });

    it("같은 헤더를 다시 누르면 정렬 방향이 바뀐다", async () => {
      await seedSortableCategories();
      renderStatsPage();

      const table = await screen.findByRole("table", { name: /주종별 통계 표/ });
      const nameHeaderButton = () =>
        within(screen.getByRole("columnheader", { name: /주종/ })).getByRole("button");
      await userEvent.click(nameHeaderButton());
      expect(categoryRowNames(table)).toEqual(["맥주", "양주"]);

      await userEvent.click(nameHeaderButton());
      expect(categoryRowNames(table)).toEqual(["양주", "맥주"]);
    });
  });
});
