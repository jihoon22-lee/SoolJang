import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryTree, Product, ProductMetrics } from "@/api/types";
import { CategoriesPage } from "@/pages/CategoriesPage";
import { ProductsPage } from "@/pages/ProductsPage";
import { db } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
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
  value_for_money: null,
};

function product(id: string, name: string): Product {
  return {
    id,
    name,
    name_en: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
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

afterEach(() => {
  vi.unstubAllGlobals();
  // 구매 완료 시 마지막 구매처 이름을 localStorage 에 남긴다(`lastVendor.ts`) — 다음
  // 테스트로 새어들지 않게 매번 지운다.
  window.localStorage.clear();
});

describe("ProductsPage", () => {
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

  /** App.tsx 가 URL 해시로 하는 선택 상태 제어를, 테스트에서는 로컬 state 로 흉내낸다. */
  function ProductsPageHarness() {
    const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
    return (
      <ProductsPage
        selectedProductId={selectedProductId}
        onSelectProduct={setSelectedProductId}
        onDeselectProduct={() => setSelectedProductId(null)}
        onOpenStoreMode={vi.fn()}
      />
    );
  }

  function renderProductsPage() {
    return renderWithQuery(
      <SyncStatusProvider>
        <ProductsPageHarness />
      </SyncStatusProvider>,
    );
  }

  /** 규격 없이 제품만 시딩한다. */
  async function seedProduct(id: string, name: string, overrides: Record<string, unknown> = {}) {
    await db.product.put(row({ id, name, category_id: null, ...overrides }));
  }

  /** 제품 + 규격 + 구매(+ 재고 병 1개)를 함께 시딩한다. 파생 지표 계산용. */
  async function seedProductWithPurchase(
    id: string,
    name: string,
    opts: { volumeMl?: number; unitListPrice?: string; inStock?: boolean } = {},
  ) {
    const { volumeMl = 700, unitListPrice, inStock = true } = opts;
    await seedProduct(id, name);
    await db.sku.put(row({ id: `${id}-sku`, product_id: id, volume_ml: volumeMl }));
    await db.purchase.put(
      row({ id: `${id}-pu`, sku_id: `${id}-sku`, quantity: 1, unit_list_price: unitListPrice }),
    );
    await db.bottle.put(
      row({
        id: `${id}-b1`,
        purchase_id: `${id}-pu`,
        label_no: 1,
        status: inStock ? "unopened" : "finished",
        remaining_ml: inStock ? null : 0,
      }),
    );
  }

  beforeEach(async () => {
    await db.open();
  });

  afterEach(async () => {
    await Promise.all([
      db.product.clear(),
      db.sku.clear(),
      db.purchase.clear(),
      db.bottle.clear(),
      db.category.clear(),
      db.vendor.clear(),
      db.variety.clear(),
      db.product_variety.clear(),
      db.outbox.clear(),
    ]);
  });

  it("목록을 불러와 표시한다", async () => {
    await seedProduct("p1", "가상 위스키");

    renderProductsPage();

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "가상 위스키" }).length).toBeGreaterThan(0);
  });

  it("페이지 크기보다 적으면 더 보기 버튼을 숨긴다", async () => {
    await seedProduct("p1", "하나뿐");

    renderProductsPage();
    await screen.findByRole("table");

    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("더 보기를 누르면 다음 페이지 분량이 화면에 더 나온다", async () => {
    // 기본 페이지 크기(30)보다 많아야 "더 보기" 가 나타난다.
    for (let i = 0; i < 31; i += 1) {
      await seedProduct(`p${i}`, `술 ${String(i).padStart(2, "0")}`);
    }

    renderProductsPage();
    await screen.findByRole("table");
    expect(screen.getByRole("heading", { name: "내 술 (31)" })).toBeInTheDocument();

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(31); // 헤더 1 + 30개

    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));

    await waitFor(() => {
      expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(32);
    });
    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("이름으로 검색하면 일치하는 제품만 남는다", async () => {
    await seedProduct("p1", "글렌캐스크 스트렝스");
    await seedProduct("p2", "라프로익");

    renderProductsPage();
    await screen.findByLabelText("이름 검색");

    await userEvent.type(screen.getByLabelText("이름 검색"), "캐스크");

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "글렌캐스크 스트렝스" }).length).toBeGreaterThan(
        0,
      );
      expect(screen.queryByRole("button", { name: "라프로익" })).not.toBeInTheDocument();
    });
  });

  it("주종·도수·평점 필터를 적용한다", async () => {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주" }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
    ]);
    await seedProduct("p1", "위스키 술", {
      category_id: "whisky",
      abv: "43.0",
      personal_rating: "4.5",
    });
    await seedProduct("p2", "다른 술", { category_id: null, abv: "5.0", personal_rating: "2.0" });

    renderProductsPage();
    // 카테고리 트리도 Dexie 라이브 쿼리라 첫 렌더에는 옵션이 비어 있을 수 있다.
    await waitFor(() => {
      expect(screen.getByLabelText("주종").querySelectorAll("option").length).toBeGreaterThan(1);
    });

    // 상위 주종을 고르면 하위(위스키)까지 포함한다.
    await userEvent.selectOptions(screen.getByLabelText("주종"), "liquor");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "위스키 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "다른 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    await userEvent.type(screen.getByLabelText("도수 (%)"), "40");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "위스키 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "다른 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    await userEvent.type(screen.getByLabelText("도수 최대"), "10");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "다른 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "위스키 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    await userEvent.type(screen.getByLabelText("내 평점 최소"), "4");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "위스키 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "다른 술" })).not.toBeInTheDocument();
    });
  });

  it("필터 패널은 기본 접힘이고 버튼으로 펼치고 접을 수 있다", async () => {
    renderProductsPage();
    const toggle = await screen.findByRole("button", { name: "펼치기" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "접기" })).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: "접기" }));
    expect(screen.getByRole("button", { name: "펼치기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("재고 필터를 적용한다", async () => {
    await seedProductWithPurchase("p1", "재고 있음", { inStock: true });
    await seedProductWithPurchase("p2", "재고 없음", { inStock: false });

    renderProductsPage();
    await screen.findByLabelText("재고");

    await userEvent.selectOptions(screen.getByLabelText("재고"), "true");

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "재고 있음" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "재고 없음" })).not.toBeInTheDocument();
    });
  });

  it("정렬 키와 방향을 적용한다", async () => {
    // 500ml/100000원 → 100ml당 20000원. 1000ml/50000원 → 100ml당 5000원.
    await seedProductWithPurchase("cheap", "저렴한 술", { volumeMl: 1000, unitListPrice: "50000" });
    await seedProductWithPurchase("pricey", "비싼 술", { volumeMl: 500, unitListPrice: "100000" });

    renderProductsPage();
    await screen.findByLabelText("정렬");

    await userEvent.selectOptions(screen.getByLabelText("정렬"), "price_per_100ml");
    await userEvent.selectOptions(screen.getByLabelText("정렬 방향"), "desc");

    await waitFor(() => {
      const table = screen.getByRole("table");
      // 정렬 헤더도 버튼이라 tbody 로 좁혀 제품 이름 버튼만 본다.
      const rows = within(table).getAllByRole("row").slice(1);
      const names = rows.map((row) => within(row).getByRole("button").textContent);
      expect(names).toEqual(["비싼 술", "저렴한 술"]);
    });
  });

  it("더 많은 필터(국가·빈티지 범위·구매처·품종·100ml당 가격 범위)를 적용한다", async () => {
    await db.vendor.bulkPut([
      row({ id: "vendorA", name: "가상마트A", kind: "mart" }),
      row({ id: "vendorB", name: "가상마트B", kind: "mart" }),
    ]);
    await db.product.bulkPut([
      row({
        id: "p1",
        name: "스코틀랜드 술",
        category_id: null,
        country: "스코틀랜드",
        vintage: 2015,
      }),
      row({ id: "p2", name: "프랑스 술", category_id: null, country: "프랑스", vintage: 2020 }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 700 }),
      row({ id: "s2", product_id: "p2", volume_ml: 700 }),
    ]);
    await db.purchase.bulkPut([
      row({
        id: "pu1",
        sku_id: "s1",
        vendor_id: "vendorA",
        quantity: 1,
        unit_list_price: "70000",
        purchased_on: "2015-05-01",
      }),
      row({
        id: "pu2",
        sku_id: "s2",
        vendor_id: "vendorB",
        quantity: 1,
        unit_list_price: "7000",
        purchased_on: "2020-05-01",
      }),
    ]);
    await db.variety.bulkPut([row({ id: "v1", name: "싱글몰트" })]);
    await db.product_variety.put(
      row({ id: "pv1", product_id: "p1", variety_id: "v1", sort_order: 0 }),
    );

    renderProductsPage();
    await screen.findAllByRole("button", { name: "스코틀랜드 술" });
    await userEvent.click(screen.getByText("더 많은 필터"));

    await userEvent.type(screen.getByLabelText("국가"), "스코틀랜드");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "스코틀랜드 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "프랑스 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    // <details> 는 리액트가 제어하지 않는 DOM 상태라 필터 초기화로 닫히지 않는다 —
    // 다시 열 필요가 없다.
    await userEvent.type(screen.getByLabelText("빈티지"), "2018");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "프랑스 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "스코틀랜드 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    // <details> 는 리액트가 제어하지 않는 DOM 상태라 필터 초기화로 닫히지 않는다 —
    // 다시 열 필요가 없다.
    await userEvent.selectOptions(screen.getByLabelText("구매처"), "vendorA");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "스코틀랜드 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "프랑스 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    // <details> 는 리액트가 제어하지 않는 DOM 상태라 필터 초기화로 닫히지 않는다 —
    // 다시 열 필요가 없다.
    await userEvent.type(screen.getByLabelText("품종·스타일"), "싱글몰트");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "스코틀랜드 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "프랑스 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    // <details> 는 리액트가 제어하지 않는 DOM 상태라 필터 초기화로 닫히지 않는다 —
    // 다시 열 필요가 없다.
    // p1: 700ml/70000원 → 100ml당 10000원. p2: 700ml/7000원 → 100ml당 1000원.
    await userEvent.type(screen.getByLabelText("100ml당 가격 (원)"), "5000");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "스코틀랜드 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "프랑스 술" })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    // <details> 는 리액트가 제어하지 않는 DOM 상태라 필터 초기화로 닫히지 않는다 —
    // 다시 열 필요가 없다. `type="date"` 입력은 userEvent.type 이 불안정해 change 로 채운다.
    fireEvent.change(screen.getByLabelText("구매일"), { target: { value: "2018-01-01" } });
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "프랑스 술" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "스코틀랜드 술" })).not.toBeInTheDocument();
    });
  });

  it("필터를 초기화한다", async () => {
    renderProductsPage();
    const search = await screen.findByLabelText("이름 검색");
    await userEvent.type(search, "라프로익");
    expect(search).toHaveValue("라프로익");

    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));

    expect(screen.getByLabelText("이름 검색")).toHaveValue("");
  });

  it("등록 폼을 열고 닫는다", async () => {
    renderProductsPage();
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
    expect(screen.getByLabelText("이름 *")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "폼 닫기" }));
    expect(screen.queryByLabelText("이름 *")).not.toBeInTheDocument();
  });

  it("온라인일 때는 기존 경로로 제품과 구매 건을 한 번에 만든다", async () => {
    // 구매처 이름을 입력하면 목록에서 찾고 없으면 만든다. 매번 고르게 하면 입력이 느려진다.
    // 온라인 경로는 품종까지 지원해야 하므로 outbox 가 아니라 기존 REST 호출을 그대로 쓴다.
    const created = product("new", "새 위스키");
    const { calls } = stubRoutes([
      { match: "/products", method: "POST", status: 201, body: created },
      { match: "/vendors", method: "GET", body: [] },
      { match: "/vendors", method: "POST", status: 201, body: { id: "v-new", name: "가상마트" } },
      { match: "/purchases", method: "POST", status: 201, body: { id: "pu1" } },
    ]);

    renderProductsPage();
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
    const form = screen.getByRole("heading", { name: "새 술 등록" }).closest("form") as HTMLElement;

    await userEvent.type(within(form).getByLabelText("이름 *"), "새 위스키");
    await userEvent.type(within(form).getByLabelText("도수 (%)"), "43");
    await userEvent.type(within(form).getByLabelText("빈티지"), "2010");
    await userEvent.type(within(form).getByLabelText("내 평점 (0.5~6)"), "4.5");
    await userEvent.type(
      within(form).getByLabelText("품종·스타일 (쉼표로 구분)"),
      "싱글몰트, 셰리캐스크",
    );
    await userEvent.type(within(form).getByLabelText("메모"), "선물 받음");
    await userEvent.type(within(form).getByLabelText("용량 (ml)"), "700");
    await userEvent.type(within(form).getByLabelText("병수"), "2");
    await userEvent.clear(within(form).getByLabelText("구매일"));
    await userEvent.type(within(form).getByLabelText("구매일"), "2026-01-01");
    await userEvent.type(within(form).getByLabelText("병당 정가 (원)"), "100000");
    await userEvent.type(within(form).getByLabelText("병당 실구매가 (원)"), "90000");
    await userEvent.type(within(form).getByLabelText("구매처"), "가상마트");
    await userEvent.click(within(form).getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/purchases"))).toBe(
        true,
      );
    });

    const productCall = calls.find(
      (call) => call.method === "POST" && call.url.includes("/products"),
    );
    expect(productCall?.body).toMatchObject({
      name: "새 위스키",
      abv: "43",
      vintage: 2010,
      personal_rating: "4.5",
      variety_names: ["싱글몰트", "셰리캐스크"],
      note: "선물 받음",
    });

    const purchaseCall = calls.find(
      (call) => call.method === "POST" && call.url.includes("/purchases"),
    );
    expect(purchaseCall?.body).toMatchObject({
      quantity: 2,
      purchased_on: "2026-01-01",
      unit_list_price: "100000",
      unit_paid_price: "90000",
      vendor_id: "v-new",
    });
  });

  it("구매 정보를 비우면 제품만 만든다", async () => {
    const { calls } = stubRoutes([
      { match: "/products", method: "POST", status: 201, body: product("only", "제품만") },
    ]);

    renderProductsPage();
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

  it("라벨 인식 결과로 폼을 채우고 등록하면 원본 사진을 첨부로 올린다", async () => {
    const created = product("labeled", "라벨로 등록한 위스키");
    const { calls } = stubRoutes([
      {
        match: "/ocr/label",
        method: "POST",
        body: {
          name: "라벨로 등록한 위스키",
          name_confidence: 0.9,
          producer: null,
          producer_confidence: 0,
          abv: 43,
          abv_confidence: 0.8,
          volume_ml: 700,
          volume_ml_confidence: 0.9,
          vintage: null,
          vintage_confidence: 0,
          age_years: null,
          age_years_confidence: 0,
          category_guess: null,
          category_guess_confidence: 0,
        },
      },
      { match: "/products", method: "POST", status: 201, body: created },
      { match: "/attachments", method: "POST", status: 201, body: { id: "att1" } },
    ]);

    renderProductsPage();
    const fileInput = await screen.findByLabelText("라벨 사진으로 등록", { selector: "input" });
    await userEvent.upload(
      fileInput,
      new File(["fake-png-bytes"], "label.png", { type: "image/png" }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "이 정보로 등록" }));

    // 프리필된 채 폼이 열린다 — 사용자가 다시 입력할 필요가 없다.
    const form = screen.getByRole("heading", { name: "새 술 등록" }).closest("form") as HTMLElement;
    expect(within(form).getByLabelText("이름 *")).toHaveValue("라벨로 등록한 위스키");
    expect(within(form).getByLabelText("도수 (%)")).toHaveValue(43);

    await userEvent.click(within(form).getByRole("button", { name: "등록" }));

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === "POST" && call.url.includes("/attachments")),
      ).toBe(true);
    });
    const attachmentCall = calls.find(
      (call) => call.method === "POST" && call.url.includes("/attachments"),
    );
    expect(attachmentCall?.body).toMatchObject({ kind: "label", product_id: "labeled" });
  });

  it("오프라인일 때는 outbox 로 제품·규격·구매·병을 한 번에 만든다", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });

    renderProductsPage();
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
    await userEvent.type(screen.getByLabelText("이름 *"), "오프라인 위스키");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.type(screen.getByLabelText("병수"), "2");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(async () => {
      const entries = await db.outbox.toArray();
      // product.create + sku.create + purchase.create — bottle 은 outbox 가 아니라
      // 로컬 미러에 직접 반영된다(서버가 purchase.create 안에서 자동 생성하므로).
      expect(entries.map((entry) => entry.entity)).toEqual(["product", "sku", "purchase"]);
    });
    const bottles = await db.bottle.toArray();
    expect(bottles).toHaveLength(2);
    expect(bottles.every((bottle) => bottle.status === "unopened")).toBe(true);
  });

  it("제품을 선택하면 상세와 구매 이력을 불러온다", async () => {
    await seedProductWithPurchase("p1", "상세 대상");

    renderProductsPage();
    const [firstLink] = await screen.findAllByRole("button", { name: "상세 대상" });
    await userEvent.click(firstLink as Element);

    expect(await screen.findByRole("heading", { name: /상세 대상/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← 목록으로" })).toBeInTheDocument();
  });

  it("제품 상세에서 수정하면 필드가 갱신된다(온라인)", async () => {
    await seedProductWithPurchase("p1", "수정 전 이름");
    const { calls } = stubRoutes([
      { match: "/products/p1", method: "PATCH", body: { ...product("p1", "수정 후 이름") } },
    ]);

    renderProductsPage();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "수정 전 이름" }))[0] as Element,
    );
    await userEvent.click(await screen.findByRole("button", { name: "수정" }));

    const nameInput = await screen.findByLabelText("이름 *");
    expect(nameInput).toHaveValue("수정 전 이름");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "수정 후 이름");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      const patchCall = calls.find((call) => call.method === "PATCH");
      expect(patchCall?.body).toMatchObject({ name: "수정 후 이름" });
    });
    // 저장 후에는 수정 폼이 아니라 상세로 돌아간다.
    expect(await screen.findByRole("button", { name: "수정" })).toBeInTheDocument();
  });

  it("구매 추가 폼을 제출하면 새 구매 건을 만든다", async () => {
    await seedProductWithPurchase("p1", "구매 추가 대상");
    const { calls } = stubRoutes([
      { match: "/purchases", method: "POST", status: 201, body: { id: "pu-new" } },
    ]);

    renderProductsPage();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "구매 추가 대상" }))[0] as Element,
    );
    await userEvent.click(await screen.findByRole("button", { name: "구매 추가" }));
    await userEvent.clear(screen.getByLabelText("병수"));
    await userEvent.type(screen.getByLabelText("병수"), "3");
    await userEvent.click(screen.getByRole("button", { name: "구매 추가" }));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.includes("/purchases"));
      expect(call?.body).toMatchObject({ quantity: 3, vendor_id: null });
    });
  });

  it("구매 건 삭제를 확인하면 삭제 요청을 보낸다", async () => {
    await seedProductWithPurchase("p1", "구매 삭제 대상");
    const { calls } = stubRoutes([
      { match: "/purchases/p1-pu", method: "DELETE", status: 204, body: null },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderProductsPage();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "구매 삭제 대상" }))[0] as Element,
    );
    // 상단 "삭제"(제품 자체)와 구별하려고 구매 행 안에서 버튼을 찾는다.
    const table = await screen.findByRole("table");
    await userEvent.click(within(table).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/purchases/p1-pu"))).toBe(
        true,
      );
    });

    vi.restoreAllMocks();
  });

  it("구매 건 분할 폼을 제출하면 분할 요청을 보낸다", async () => {
    // 분할 버튼은 quantity > 1 일 때만 있다 — 병 2개로 시딩한다.
    await seedProduct("p1", "구매 분할 대상");
    await db.sku.put(row({ id: "p1-sku", product_id: "p1", volume_ml: 700 }));
    await db.purchase.put(row({ id: "p1-pu", sku_id: "p1-sku", quantity: 2 }));
    const { calls } = stubRoutes([
      { match: "/purchases/p1-pu:split", method: "POST", body: [{ id: "a" }, { id: "b" }] },
    ]);

    renderProductsPage();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "구매 분할 대상" }))[0] as Element,
    );
    await userEvent.click(await screen.findByRole("button", { name: "분할" }));
    await userEvent.click(screen.getByRole("button", { name: "분할 실행" }));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.includes(":split"));
      expect(call?.body).toEqual({
        parts: [
          { quantity: 1, vendor_id: null },
          { quantity: 1, vendor_id: null },
        ],
      });
    });
  });

  it("규격이 없는 제품은 규격 추가 후에야 구매를 추가할 수 있다", async () => {
    await seedProduct("p1", "규격 없는 술");
    const { calls } = stubRoutes([
      { match: "/products/p1/skus", method: "POST", body: { id: "sku-new" } },
    ]);

    renderProductsPage();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "규격 없는 술" }))[0] as Element,
    );
    await userEvent.click(await screen.findByRole("button", { name: "구매 추가" }));
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "500");
    await userEvent.click(screen.getByRole("button", { name: "규격 추가" }));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.includes("/skus"));
      expect(call?.body).toMatchObject({ volume_ml: 500 });
    });
  });

  it("병 섹션에서 병을 펼치면 상태 전이 버튼이 나온다", async () => {
    await seedProductWithPurchase("p1", "병 있는 대상");
    stubRoutes([
      { match: "/bottles/p1-b1/tastings", body: [] },
      {
        match: "/tastings/summary",
        body: { session_count: 0, average_rating: null, rating_change: null, total_poured_ml: 0 },
      },
    ]);

    renderProductsPage();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "병 있는 대상" }))[0] as Element,
    );
    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));

    expect(await screen.findByRole("button", { name: "개봉" })).toBeInTheDocument();
  });

  it("상세에서 목록으로 돌아온다", async () => {
    await seedProductWithPurchase("p1", "왕복 대상");

    renderProductsPage();
    const [link] = await screen.findAllByRole("button", { name: "왕복 대상" });
    await userEvent.click(link as Element);
    await userEvent.click(await screen.findByRole("button", { name: "← 목록으로" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("상세에서 돌아오면 들어가기 전 스크롤 위치를 복원한다", async () => {
    await seedProductWithPurchase("p1", "스크롤 대상");
    const scrollToSpy = vi.spyOn(window, "scrollTo");
    Object.defineProperty(window, "scrollY", { value: 500, configurable: true });

    renderProductsPage();
    const [link] = await screen.findAllByRole("button", { name: "스크롤 대상" });
    await userEvent.click(link as Element);
    await userEvent.click(await screen.findByRole("button", { name: "← 목록으로" }));

    expect(scrollToSpy).toHaveBeenCalledWith(0, 500);
    scrollToSpy.mockRestore();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  describe("키보드 단축키", () => {
    it("/ 를 누르면 이름 검색으로 포커스를 옮긴다", async () => {
      await seedProduct("p1", "아무 술");
      renderProductsPage();
      await screen.findByRole("table");

      await userEvent.keyboard("/");

      expect(screen.getByLabelText("이름 검색")).toHaveFocus();
      // 모바일 폭에서 기본 접힘인 필터 패널이 단축키로 무력화되면 안 된다(항목 2) —
      // 접힌 채로 시작했더라도 펼침 상태로 전환돼 있어야 한다.
      expect(screen.getByRole("button", { name: "접기" })).toHaveAttribute("aria-expanded", "true");
    });

    it("이미 입력 중이면 / 를 그냥 문자로 받는다", async () => {
      await seedProduct("p1", "아무 술");
      renderProductsPage();
      const search = await screen.findByLabelText("이름 검색");

      await userEvent.click(search);
      await userEvent.keyboard("/");

      expect(search).toHaveValue("/");
    });

    it("Esc 를 누르면 등록 폼을 닫는다", async () => {
      await seedProduct("p1", "아무 술");
      renderProductsPage();
      await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
      expect(screen.getByRole("heading", { name: "새 술 등록" })).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");

      expect(screen.queryByRole("heading", { name: "새 술 등록" })).not.toBeInTheDocument();
    });
  });

  it("보던 중 제품이 사라지면 알리고 돌아갈 길을 남긴다", async () => {
    await seedProduct("p1", "실패 대상");

    renderProductsPage();
    const [link] = await screen.findAllByRole("button", { name: "실패 대상" });
    await userEvent.click(link as Element);
    await screen.findByRole("heading", { name: /실패 대상/ });

    // 다른 기기가 동기화로 지운 상황을 흉내낸다.
    await db.product.update("p1", { deleted_at: NOW });

    expect(await screen.findByRole("alert")).toHaveTextContent("제품을 불러올 수 없습니다");
    expect(screen.getByRole("button", { name: "← 목록으로" })).toBeInTheDocument();
  });
});

describe("CategoriesPage", () => {
  const NOW = "2026-01-01T00:00:00Z";

  function categoryRow(overrides: Record<string, unknown>) {
    return {
      id: "row",
      user_id: "u1",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      parent_id: null,
      slug: "row",
      sort_order: 0,
      is_seeded: false,
      note: null,
      ...overrides,
    };
  }

  function renderCategoriesPage() {
    return renderWithQuery(
      <SyncStatusProvider>
        <CategoriesPage />
      </SyncStatusProvider>,
    );
  }

  beforeEach(async () => {
    await db.open();
  });

  afterEach(async () => {
    await db.category.clear();
    await db.product.clear();
    await db.outbox.clear();
  });

  it("계층을 불러와 관리 화면을 보여준다", async () => {
    await db.category.put(categoryRow({ id: "whisky", name: "위스키", is_seeded: true }));

    renderCategoriesPage();

    expect(await screen.findByRole("heading", { name: "주종 관리" })).toBeInTheDocument();
    expect(
      await screen.findByText("위스키", { selector: ".category-row .name" }),
    ).toBeInTheDocument();
  });

  it("주종을 추가하면 outbox 에 쌓이고 즉시 화면에 보인다", async () => {
    renderCategoriesPage();

    await userEvent.click(await screen.findByRole("button", { name: "+ 주종 추가" }));
    await userEvent.type(screen.getByLabelText("이름"), "새 주종");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    // "새 주종" 자체가 상위 주종 선택 드롭다운 옵션에도 나타나므로, 행에만 있는
    // `.category-row .name` 으로 범위를 좁혀 존재를 확인한다.
    expect(
      await screen.findByText("새 주종", { selector: ".category-row .name" }),
    ).toBeInTheDocument();
    const entries = await db.outbox.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity: "category", op: "create" });
    expect(entries[0]?.fields).toMatchObject({ name: "새 주종", parent_id: null });
  });

  it("기본 주종을 복원한다", async () => {
    const { calls } = stubRoutes([{ match: "/categories:reset-seed", method: "POST", body: {} }]);

    renderCategoriesPage();
    await userEvent.click(await screen.findByRole("button", { name: "기본 주종 복원" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("reset-seed"))).toBe(true);
    });
  });

  it("이름을 변경하면 outbox 에 쌓이고 즉시 화면에 반영된다", async () => {
    await db.category.put(categoryRow({ id: "whisky", name: "위스키", is_seeded: true }));

    renderCategoriesPage();
    await userEvent.click(await screen.findByRole("button", { name: "이름 변경" }));
    const input = screen.getByLabelText("위스키 새 이름");
    await userEvent.clear(input);
    await userEvent.type(input, "양주");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(
      await screen.findByText("양주", { selector: ".category-row .name" }),
    ).toBeInTheDocument();
    const entries = await db.outbox.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity: "category", op: "update", entity_id: "whisky" });
    expect(entries[0]?.fields).toMatchObject({ name: "양주" });
  });

  it("삭제 시 소속 제품 처리 방식을 서버에 전달한다", async () => {
    await db.category.bulkPut([
      categoryRow({ id: "whisky", name: "위스키" }),
      categoryRow({ id: "target", name: "옮길 곳", sort_order: 1 }),
    ]);
    await db.product.put({
      id: "p1",
      user_id: "u1",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      category_id: "whisky",
      name: "글렌알라키",
    });
    const { calls } = stubRoutes([
      { match: "/categories/whisky", method: "DELETE", body: emptyTree },
    ]);

    renderCategoriesPage();
    const row = (await screen.findByText("위스키", { selector: ".category-row .name" })).closest(
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
});
