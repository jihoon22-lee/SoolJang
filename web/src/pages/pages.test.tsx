import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryTree, Product, ProductMetrics } from "@/api/types";
import { CategoriesPage } from "@/pages/CategoriesPage";
import { ProductsPage } from "@/pages/ProductsPage";
import { renderWithQuery, stubRoutes } from "@/testing";

const zeroMetrics: ProductMetrics = {
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
};

function product(id: string, name: string): Product {
  return {
    id,
    name,
    name_en: null,
    category_id: null,
    category_path: [],
    producer_id: null,
    producer_name: null,
    country: null,
    region: null,
    abv: null,
    vintage: null,
    age_years: null,
    personal_rating: null,
    note: null,
    varieties: [],
    skus: [
      { id: `${id}-sku`, volume_ml: 700, barcode: null, barcode_type: null, package_note: null },
    ],
    metrics: { ...zeroMetrics },
  };
}

const emptyTree: CategoryTree = { items: [], max_depth: 0, depth_limit: 8 };

const seededTree: CategoryTree = {
  items: [
    {
      id: "whisky",
      parent_id: null,
      name: "위스키",
      depth: 1,
      path: ["위스키"],
      is_seeded: true,
      sort_order: 0,
      product_count: 1,
      descendant_product_count: 2,
    },
  ],
  max_depth: 1,
  depth_limit: 8,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProductsPage", () => {
  it("목록을 불러와 표시한다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      {
        match: "/products",
        body: { items: [product("p1", "가상 위스키")], next_cursor: null },
      },
    ]);

    renderWithQuery(<ProductsPage />);

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "가상 위스키" }).length).toBeGreaterThan(0);
  });

  it("다음 페이지가 없으면 더 보기 버튼을 숨긴다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [product("p1", "하나뿐")], next_cursor: null } },
    ]);

    renderWithQuery(<ProductsPage />);
    await screen.findByRole("table");

    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("더 보기를 누르면 커서를 실어 다음 페이지를 요청한다", async () => {
    // 커서를 그대로 이어 보내야 중복·누락이 없다.
    const { calls } = stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [product("p1", "첫 장")], next_cursor: "CURSOR-1" } },
    ]);

    renderWithQuery(<ProductsPage />);
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("cursor=CURSOR-1"))).toBe(true);
    });
  });

  it("필터를 바꾸면 서버에 조건을 전달한다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [], next_cursor: null } },
    ]);

    renderWithQuery(<ProductsPage />);
    await screen.findByLabelText("이름 검색");

    await userEvent.type(screen.getByLabelText("이름 검색"), "캐스크");

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes(`q=${encodeURIComponent("캐스크")}`))).toBe(
        true,
      );
    });
  });

  it("재고 필터를 전달한다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [], next_cursor: null } },
    ]);

    renderWithQuery(<ProductsPage />);
    await screen.findByLabelText("재고");

    await userEvent.selectOptions(screen.getByLabelText("재고"), "true");

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("in_stock=true"))).toBe(true);
    });
  });

  it("정렬 키와 방향을 전달한다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [], next_cursor: null } },
    ]);

    renderWithQuery(<ProductsPage />);
    await screen.findByLabelText("정렬");

    await userEvent.selectOptions(screen.getByLabelText("정렬"), "price_per_100ml");
    await userEvent.selectOptions(screen.getByLabelText("정렬 방향"), "desc");

    await waitFor(() => {
      expect(
        calls.some(
          (call) => call.url.includes("sort=price_per_100ml") && call.url.includes("order=desc"),
        ),
      ).toBe(true);
    });
  });

  it("필터를 초기화한다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [], next_cursor: null } },
    ]);

    renderWithQuery(<ProductsPage />);
    const search = await screen.findByLabelText("이름 검색");
    await userEvent.type(search, "라프로익");
    expect(search).toHaveValue("라프로익");

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));

    expect(screen.getByLabelText("이름 검색")).toHaveValue("");
  });

  it("등록 폼을 열고 닫는다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", body: { items: [], next_cursor: null } },
    ]);

    renderWithQuery(<ProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
    expect(screen.getByLabelText("이름 *")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "폼 닫기" }));
    expect(screen.queryByLabelText("이름 *")).not.toBeInTheDocument();
  });

  it("제품과 구매 건을 한 번에 만든다", async () => {
    // 구매처 이름을 입력하면 목록에서 찾고 없으면 만든다. 매번 고르게 하면 입력이 느려진다.
    const created = product("new", "새 위스키");
    const { calls } = stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", method: "GET", body: { items: [], next_cursor: null } },
      { match: "/products", method: "POST", status: 201, body: created },
      { match: "/vendors", method: "GET", body: [] },
      { match: "/vendors", method: "POST", status: 201, body: { id: "v-new", name: "가상마트" } },
      { match: "/purchases", method: "POST", status: 201, body: { id: "pu1" } },
    ]);

    renderWithQuery(<ProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));

    await userEvent.type(screen.getByLabelText("이름 *"), "새 위스키");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.type(screen.getByLabelText("병수"), "2");
    await userEvent.type(screen.getByLabelText("병당 실구매가 (원)"), "90000");
    await userEvent.type(screen.getByLabelText("구매처"), "가상마트");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/purchases"))).toBe(
        true,
      );
    });

    const purchaseCall = calls.find(
      (call) => call.method === "POST" && call.url.includes("/purchases"),
    );
    expect(purchaseCall?.body).toMatchObject({
      quantity: 2,
      unit_paid_price: "90000",
      vendor_id: "v-new",
    });
  });

  it("구매 정보를 비우면 제품만 만든다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", method: "GET", body: { items: [], next_cursor: null } },
      { match: "/products", method: "POST", status: 201, body: product("only", "제품만") },
    ]);

    renderWithQuery(<ProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
    await userEvent.type(screen.getByLabelText("이름 *"), "제품만");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/products"))).toBe(
        true,
      );
    });
    expect(calls.some((call) => call.url.includes("/purchases"))).toBe(false);
  });

  it("목록 조회 실패를 alert 로 알린다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products", status: 500, body: { detail: "서버 오류" } },
    ]);

    renderWithQuery(<ProductsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("목록을 불러올 수 없습니다");
  });

  it("제품을 선택하면 상세와 구매 이력을 불러온다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products?", body: { items: [product("p1", "상세 대상")], next_cursor: null } },
      { match: "/products/p1", body: product("p1", "상세 대상") },
      { match: "/purchases", body: [] },
    ]);

    renderWithQuery(<ProductsPage />);
    const [firstLink] = await screen.findAllByRole("button", { name: "상세 대상" });
    await userEvent.click(firstLink as Element);

    expect(await screen.findByRole("heading", { name: /상세 대상/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← 목록으로" })).toBeInTheDocument();
  });

  it("상세에서 목록으로 돌아온다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products?", body: { items: [product("p1", "왕복 대상")], next_cursor: null } },
      { match: "/products/p1", body: product("p1", "왕복 대상") },
      { match: "/purchases", body: [] },
    ]);

    renderWithQuery(<ProductsPage />);
    const [link] = await screen.findAllByRole("button", { name: "왕복 대상" });
    await userEvent.click(link as Element);
    await userEvent.click(await screen.findByRole("button", { name: "← 목록으로" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("상세 조회 실패를 알리고 돌아갈 길을 남긴다", async () => {
    stubRoutes([
      { match: "/categories", body: emptyTree },
      { match: "/products?", body: { items: [product("p1", "실패 대상")], next_cursor: null } },
      { match: "/products/p1", status: 404, body: { detail: "제품을 찾을 수 없습니다" } },
      { match: "/purchases", body: [] },
    ]);

    renderWithQuery(<ProductsPage />);
    const [link] = await screen.findAllByRole("button", { name: "실패 대상" });
    await userEvent.click(link as Element);

    expect(await screen.findByRole("alert")).toHaveTextContent("제품을 불러올 수 없습니다");
    expect(screen.getByRole("button", { name: "← 목록으로" })).toBeInTheDocument();
  });
});

describe("CategoriesPage", () => {
  it("계층을 불러와 관리 화면을 보여준다", async () => {
    stubRoutes([{ match: "/categories", body: seededTree }]);

    renderWithQuery(<CategoriesPage />);

    expect(await screen.findByRole("heading", { name: "주종 관리" })).toBeInTheDocument();
    expect(
      within(
        screen.getByLabelText("위스키 상위 주종 변경").closest(".category-row") as HTMLElement,
      ).getByText("위스키"),
    ).toBeInTheDocument();
  });

  it("주종을 추가한다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", method: "GET", body: emptyTree },
      { match: "/categories", method: "POST", status: 201, body: {} },
    ]);

    renderWithQuery(<CategoriesPage />);
    await userEvent.type(await screen.findByLabelText("이름"), "새 주종");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    await waitFor(() => {
      const call = calls.find((item) => item.method === "POST");
      expect(call?.body).toMatchObject({ name: "새 주종", parent_id: null });
    });
  });

  it("기본 주종을 복원한다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", method: "GET", body: emptyTree },
      { match: "/categories:reset-seed", method: "POST", body: seededTree },
    ]);

    renderWithQuery(<CategoriesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "기본 주종 복원" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("reset-seed"))).toBe(true);
    });
  });

  it("이름을 변경한다", async () => {
    const { calls } = stubRoutes([
      { match: "/categories", method: "GET", body: seededTree },
      { match: "/categories/whisky", method: "PATCH", body: {} },
    ]);

    renderWithQuery(<CategoriesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "이름 변경" }));
    const input = screen.getByLabelText("위스키 새 이름");
    await userEvent.clear(input);
    await userEvent.type(input, "양주");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      const call = calls.find((item) => item.method === "PATCH");
      expect(call?.body).toMatchObject({ name: "양주" });
    });
  });

  it("삭제 시 소속 제품 처리 방식을 서버에 전달한다", async () => {
    const twoNodes: CategoryTree = {
      ...seededTree,
      items: [
        ...seededTree.items,
        {
          id: "target",
          parent_id: null,
          name: "옮길 곳",
          depth: 1,
          path: ["옮길 곳"],
          is_seeded: false,
          sort_order: 1,
          product_count: 0,
          descendant_product_count: 0,
        },
      ],
    };
    const { calls } = stubRoutes([
      { match: "/categories", method: "GET", body: twoNodes },
      { match: "/categories/whisky", method: "DELETE", body: twoNodes },
    ]);

    renderWithQuery(<CategoriesPage />);
    const row = (await screen.findByLabelText("위스키 상위 주종 변경")).closest(
      ".category-row",
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "삭제" }));
    await userEvent.selectOptions(within(row).getByLabelText("위스키 의 술을 옮길 주종"), "target");
    await userEvent.click(within(row).getByRole("button", { name: "옮기고 삭제" }));

    await waitFor(() => {
      const call = calls.find((item) => item.method === "DELETE");
      expect(call?.url).toContain("strategy=reassign");
      expect(call?.url).toContain("target_id=target");
    });
  });

  it("계층 조회 실패를 알린다", async () => {
    stubRoutes([{ match: "/categories", status: 500, body: { detail: "서버 오류" } }]);

    renderWithQuery(<CategoriesPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("주종을 불러올 수 없습니다");
  });
});
