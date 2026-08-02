import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryNode } from "@/api/types";
import { PivotExplorer } from "@/components/PivotExplorer";
import { renderWithQuery, stubRoutes } from "@/testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATEGORIES: CategoryNode[] = [
  {
    id: "cat-whiskey",
    parent_id: null,
    name: "위스키",
    depth: 0,
    path: ["위스키"],
    is_seeded: true,
    sort_order: 0,
    product_count: 0,
    descendant_product_count: 0,
  },
];

function baseRoutes(overrides: Parameters<typeof stubRoutes>[0] = []) {
  return stubRoutes([
    // 앞에 둔다 — stubRoutes 는 배열의 첫 매치를 쓰므로, 오버라이드가 기본값보다 먼저
    // 와야 같은 경로를 재정의할 수 있다.
    ...overrides,
    {
      match: "/vendors",
      method: "GET",
      body: [
        { id: "v1", name: "가상마트", kind: "mart", url: null, note: null, purchase_count: 1 },
      ],
    },
    { match: "/saved-views", method: "GET", body: [] },
    { match: "/stats/timeseries", method: "GET", body: [] },
  ]);
}

describe("PivotExplorer", () => {
  it("기본 상태를 보여준다", async () => {
    baseRoutes();
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    expect(screen.getByRole("button", { name: "실행" })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("구매처 필터")).getByText("가상마트"),
      ).toBeInTheDocument();
    });
  });

  it("열 축을 지정해 실행하면 행×열 표를 보여준다", async () => {
    baseRoutes([
      {
        match: "/stats/pivot",
        method: "POST",
        body: [
          {
            row_key: "v1",
            row_label: "가상마트",
            column_key: "c1",
            column_label: "위스키",
            value: "0.2000",
            bottle_count: 2,
          },
        ],
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await userEvent.click(screen.getByRole("button", { name: "실행" }));

    const table = await screen.findByRole("table");
    expect(within(table).getByText("가상마트")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "위스키" })).toBeInTheDocument();
    expect(within(table).getByText("20%")).toBeInTheDocument();
  });

  it("열 축이 없으면 1차원 표를 보여준다", async () => {
    baseRoutes([
      {
        match: "/stats/pivot",
        method: "POST",
        body: [
          {
            row_key: "v1",
            row_label: "가상마트",
            column_key: null,
            column_label: "",
            value: "3",
            bottle_count: 3,
          },
        ],
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await userEvent.selectOptions(screen.getByLabelText("열 기준 (선택)"), "");
    await userEvent.selectOptions(screen.getByLabelText("지표"), "bottle_count");
    await userEvent.click(screen.getByRole("button", { name: "실행" }));

    const table = await screen.findByRole("table");
    expect(within(table).getByText("가상마트")).toBeInTheDocument();
    expect(within(table).getByText("3병")).toBeInTheDocument();
  });

  it("결과가 없으면 안내 문구를 보여준다", async () => {
    baseRoutes([{ match: "/stats/pivot", method: "POST", body: [] }]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await userEvent.click(screen.getByRole("button", { name: "실행" }));

    expect(await screen.findByText("조건에 맞는 구매 기록이 없습니다.")).toBeInTheDocument();
  });

  it("피벗 실패는 오류 메시지를 보여준다", async () => {
    baseRoutes([
      {
        match: "/stats/pivot",
        method: "POST",
        status: 422,
        body: {
          type: "https://sooljang.local/errors/validation",
          title: "요청 값이 올바르지 않습니다",
          status: 422,
          detail: "지원하지 않는 지표입니다",
          errors: [],
        },
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await userEvent.click(screen.getByRole("button", { name: "실행" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("지원하지 않는 지표입니다");
  });

  it("뷰를 저장하면 저장된 뷰 목록에 다시 나타난다", async () => {
    const { calls } = baseRoutes([
      {
        match: "/stats/pivot",
        method: "POST",
        body: [
          {
            row_key: "v1",
            row_label: "가상마트",
            column_key: "c1",
            column_label: "위스키",
            value: "0.2000",
            bottle_count: 2,
          },
        ],
      },
      {
        match: "/saved-views",
        method: "POST",
        status: 201,
        body: {
          id: "sv1",
          name: "내 뷰",
          definition: {
            row_dimension: "vendor",
            column_dimension: "category",
            metric: "discount_rate",
          },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await userEvent.click(screen.getByRole("button", { name: "실행" }));
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText("저장할 뷰 이름"), "내 뷰");
    await userEvent.click(screen.getByRole("button", { name: "이 뷰 저장" }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.method === "POST" && call.url.includes("/saved-views"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({ name: "내 뷰" });
    });
  });

  it("CSV 내보내기는 링크를 만들어 클릭한다", async () => {
    baseRoutes([
      {
        match: "/stats/pivot",
        method: "POST",
        body: [
          {
            row_key: "v1",
            row_label: "가상마트",
            column_key: null,
            column_label: "",
            value: "3",
            bottle_count: 3,
          },
        ],
      },
    ]);
    // 전체 URL 전역을 바꿔치기하지 않는다 — 그러면 생성자가 사라져 fetch 등 다른 코드가
    // 깨진다. 이 두 정적 메서드만 얹는다(jsdom 엔 원래 없다).
    const createObjectURL = vi.fn().mockReturnValue("blob:fake");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      renderWithQuery(<PivotExplorer categories={CATEGORIES} />);
      await userEvent.click(screen.getByRole("button", { name: "실행" }));
      await screen.findByRole("table");

      await userEvent.click(screen.getByRole("button", { name: "CSV 내보내기" }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      clickSpy.mockRestore();
      // @ts-expect-error jsdom 이 원래 정의하지 않는 메서드라 되돌릴 원본이 없다.
      URL.createObjectURL = undefined;
      // @ts-expect-error 위와 같음.
      URL.revokeObjectURL = undefined;
    }
  });

  it("저장된 뷰를 불러오면 다시 실행한다", async () => {
    const savedView = {
      id: "sv1",
      name: "구매처 x 주종",
      definition: { row_dimension: "vendor", column_dimension: "category", metric: "bottle_count" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    baseRoutes([
      { match: "/saved-views", method: "GET", body: [savedView] },
      {
        match: "/stats/pivot",
        method: "POST",
        body: [
          {
            row_key: "v1",
            row_label: "가상마트",
            column_key: "c1",
            column_label: "위스키",
            value: "5",
            bottle_count: 5,
          },
        ],
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await userEvent.click(await screen.findByRole("button", { name: "불러오기" }));

    const table = await screen.findByRole("table");
    expect(within(table).getByText("가상마트")).toBeInTheDocument();
  });

  it("삭제 버튼을 누르면 DELETE 요청을 보낸다", async () => {
    const savedView = {
      id: "sv1",
      name: "지울 뷰",
      definition: { row_dimension: "vendor", metric: "bottle_count" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const { calls } = baseRoutes([
      { match: "/saved-views", method: "GET", body: [savedView] },
      { match: "/saved-views/sv1", method: "DELETE", status: 204, body: null },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    await screen.findByText("지울 뷰");
    await userEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      const deleteCall = calls.find(
        (call) => call.method === "DELETE" && call.url.includes("/saved-views/sv1"),
      );
      expect(deleteCall).toBeDefined();
    });
  });

  it("월별 시계열을 표로 보여준다", async () => {
    baseRoutes([
      {
        match: "/stats/timeseries",
        method: "GET",
        body: [
          { month: "2026-01", bottle_count: 3, paid_total: "90000.00" },
          { month: "2026-02", bottle_count: 1, paid_total: "10000.00" },
        ],
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    expect((await screen.findAllByText("2026-01")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-02").length).toBeGreaterThan(0);
    expect(screen.getByText("90,000원")).toBeInTheDocument();
  });

  it("시계열이 비어 있으면 안내 문구를 보여준다", async () => {
    baseRoutes();
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);

    expect(await screen.findByText("구매일이 기록된 구매 건이 없습니다.")).toBeInTheDocument();
  });

  it("행 기준·필터를 바꾸고 가성비 지표로 실행한다", async () => {
    baseRoutes([
      {
        match: "/stats/pivot",
        method: "POST",
        body: [
          {
            row_key: "c1",
            row_label: "위스키",
            column_key: null,
            column_label: "",
            value: "31.85",
            bottle_count: 1,
          },
        ],
      },
    ]);
    renderWithQuery(<PivotExplorer categories={CATEGORIES} />);
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("구매처 필터")).getByText("가상마트"),
      ).toBeInTheDocument();
    });

    await userEvent.selectOptions(screen.getByLabelText("행 기준"), "category");
    await userEvent.selectOptions(screen.getByLabelText("열 기준 (선택)"), "");
    await userEvent.selectOptions(screen.getByLabelText("지표"), "value_for_money");
    await userEvent.selectOptions(screen.getByLabelText("구매처 필터"), "v1");
    await userEvent.selectOptions(screen.getByLabelText("주종 필터"), "cat-whiskey");
    await userEvent.click(screen.getByRole("button", { name: "실행" }));

    const table = await screen.findByRole("table");
    expect(within(table).getByText("위스키")).toBeInTheDocument();
    expect(within(table).getByText("31.85")).toBeInTheDocument();
  });
});
