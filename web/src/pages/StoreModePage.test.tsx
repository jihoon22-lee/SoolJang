import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product, ProductMetrics } from "@/api/types";
import { StoreModePage } from "@/pages/StoreModePage";
import { db } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

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

function apiProduct(id: string, name: string): Product {
  return {
    id,
    name,
    name_en: null,
    created_at: NOW,
    updated_at: NOW,
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
    skus: [],
    metrics: { ...zeroMetrics },
  };
}

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

/** 제품 + 규격 + 구매(+ 재고 병) 를 함께 시딩한다. */
async function seedProductWithPurchase(
  id: string,
  name: string,
  opts: { unitPaidPrice?: string; withPurchase?: boolean } = {},
) {
  const { unitPaidPrice, withPurchase = true } = opts;
  await db.product.put(row({ id, name, category_id: null }));
  await db.sku.put(row({ id: `${id}-sku`, product_id: id, volume_ml: 700 }));
  if (withPurchase) {
    await db.purchase.put(
      row({
        id: `${id}-pu`,
        sku_id: `${id}-sku`,
        quantity: 1,
        purchased_on: "2026-01-01",
        unit_paid_price: unitPaidPrice,
      }),
    );
    await db.bottle.put(
      row({ id: `${id}-b1`, purchase_id: `${id}-pu`, label_no: 1, status: "unopened" }),
    );
  }
}

function renderStoreMode(onOpenDetail = vi.fn()) {
  renderWithQuery(
    <SyncStatusProvider>
      <StoreModePage onOpenDetail={onOpenDetail} />
    </SyncStatusProvider>,
  );
  return { onOpenDetail };
}

/** 검색 결과 목록에서 항목을 고른다 — "새로 등록" 버튼도 같은 이름을 포함해 전체 화면
 * 기준으로는 이름이 모호하다. */
async function selectResult(name: string): Promise<void> {
  const list = await screen.findByRole("list");
  await userEvent.click(within(list).getByRole("button", { name: new RegExp(name) }));
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([db.product.clear(), db.sku.clear(), db.purchase.clear(), db.bottle.clear()]);
});

describe("StoreModePage", () => {
  it("일치하는 술이 없으면 새로 등록 버튼을 보여준다", async () => {
    renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "글렌피딕");

    expect(await screen.findByText(/일치하는 술이 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: '"글렌피딕" 새로 등록' })).toBeInTheDocument();
  });

  it("검색 결과를 누르면 구매가·재고 요약을 보여준다", async () => {
    await seedProductWithPurchase("p1", "글렌피딕 12년", { unitPaidPrice: "90000" });
    renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "글렌피딕");
    await selectResult("글렌피딕 12년");

    expect(await screen.findByRole("heading", { name: "글렌피딕 12년" })).toBeInTheDocument();
    expect(screen.getByText("1병")).toBeInTheDocument();
    // 구매가 한 건뿐이라 최근·최저·평균이 모두 같은 값이다.
    expect(screen.getAllByText("90,000원")).toHaveLength(3);
  });

  it("구매 기록이 없으면 가격 대신 안내를 보여준다", async () => {
    await seedProductWithPurchase("p2", "구매 기록 없는 술", { withPurchase: false });
    renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "구매 기록 없는 술");
    await selectResult("구매 기록 없는 술");

    await screen.findByRole("heading", { name: "구매 기록 없는 술" });
    expect(screen.getAllByText("구매 기록 없음")).toHaveLength(2);
  });

  it("상세로 이동 버튼은 onOpenDetail 을 호출한다", async () => {
    await seedProductWithPurchase("p3", "이동 테스트 술", { withPurchase: false });
    const { onOpenDetail } = renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "이동 테스트 술");
    await selectResult("이동 테스트 술");
    await userEvent.click(await screen.findByRole("button", { name: /상세로 이동/ }));

    expect(onOpenDetail).toHaveBeenCalledWith("p3");
  });

  it("요약 화면에 외부 정보 조회 버튼을 보여준다", async () => {
    await seedProductWithPurchase("p4", "외부 정보 테스트 술", { withPurchase: false });
    renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "외부 정보 테스트 술");
    await selectResult("외부 정보 테스트 술");

    expect(await screen.findByRole("button", { name: "외부 정보 조회" })).toBeInTheDocument();
  });

  it("새로 등록하면 서버 응답을 로컬 미러에 반영하고 요약으로 넘어간다", async () => {
    const created = apiProduct("new-1", "새로 등록한 술");
    stubRoutes([{ match: "/products", method: "POST", status: 201, body: created }]);
    renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "새로 등록한 술");
    await userEvent.click(
      await screen.findByRole("button", { name: '"새로 등록한 술" 새로 등록' }),
    );

    await screen.findByRole("heading", { name: "새 술 등록" });
    expect(screen.getByLabelText("이름 *")).toHaveValue("새로 등록한 술");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    await waitFor(async () => {
      expect(await db.product.get("new-1")).toMatchObject({ name: "새로 등록한 술" });
    });
    expect(await screen.findByRole("heading", { name: "새로 등록한 술" })).toBeInTheDocument();
  });

  it("구매 저장이 실패한 뒤 재시도해도 제품을 다시 만들지 않는다(B7)", async () => {
    // 제품 생성은 항상 성공하지만 구매 생성은 첫 호출만 실패시킨다 — "제품은 이미
    // 서버에 있는데 구매 저장에 실패해 폼이 다시 열리는" 상황을 재현한다. 재시도가
    // `POST /products` 를 또 부르면(멱등키가 없어) 중복 제품이 생긴다.
    const created = {
      ...apiProduct("new-2", "재시도 테스트 술"),
      skus: [
        { id: "sku-2", volume_ml: 700, barcode: null, barcode_type: null, package_note: null },
      ],
    };
    let purchaseCalls = 0;
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/products") && method === "POST") {
        return new Response(JSON.stringify(created), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/purchases") && method === "POST") {
        purchaseCalls += 1;
        if (purchaseCalls === 1) {
          return new Response(JSON.stringify({ detail: "일시적 오류" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "pu-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: `스텁 없음: ${method} ${url}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", spy);

    renderStoreMode();

    await userEvent.type(screen.getByLabelText("이름으로 찾기"), "재시도 테스트 술");
    await userEvent.click(
      await screen.findByRole("button", { name: '"재시도 테스트 술" 새로 등록' }),
    );
    await screen.findByRole("heading", { name: "새 술 등록" });
    // 이름은 검색어로 이미 채워져 있다 — 다시 입력하면 값이 겹쳐 붙는다.
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.type(screen.getByLabelText("병수"), "1");

    await userEvent.click(screen.getByRole("button", { name: "등록" }));
    expect(await screen.findByText(/재시도 테스트 술.*이미 등록됐습니다/)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.product.get("new-2")).toMatchObject({ name: "재시도 테스트 술" });
    });

    await userEvent.click(screen.getByRole("button", { name: "등록" }));
    expect(await screen.findByRole("heading", { name: "재시도 테스트 술" })).toBeInTheDocument();

    const productCalls = spy.mock.calls.filter(([input, init]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes("/products") && (init?.method ?? "GET").toUpperCase() === "POST";
    });
    expect(productCalls).toHaveLength(1);
    expect(purchaseCalls).toBe(2);
  });
});
