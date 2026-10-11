import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tastingsApi } from "@/api/client";
import type { ContextualTasting, Product } from "@/api/types";
import { ToastProvider } from "@/components/Toast";
import { ProductsPage } from "@/pages/ProductsPage";
import { type ProductContext, parseHash, routeToHash } from "@/router";
import { activateDatabase, db } from "@/sync/db";
import { renderWithQuery } from "@/testing";

interface DetailProps {
  product: Product;
  selectedSkuId?: string | undefined;
  selectedPurchaseId?: string | undefined;
  selectedBottleId?: string | undefined;
  selectedTastingId?: string | undefined;
  editTasting?: boolean | undefined;
  onTastingDeleted?: ((record: ContextualTasting) => void) | undefined;
  onCorrectionSavingChange?: ((saving: boolean) => void) | undefined;
  onTastingCorrected?: ((record: ContextualTasting) => void) | undefined;
}
const controls = vi.hoisted(() => ({
  detail: null as DetailProps | null,
  mounts: 0,
  renders: 0,
  navigate: vi.fn(),
  triggerSync: vi.fn(),
}));
vi.mock("@/sync/SyncStatusProvider", () => ({
  useSyncStatus: () => ({
    state: "idle",
    lastSyncedAt: null,
    lastError: null,
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    quarantineCount: 0,
    triggerSync: controls.triggerSync,
  }),
}));
vi.mock("@/components/ProductDetail", async () => {
  const { useState } = await import("react");
  return {
    ProductDetail: (props: DetailProps) => {
      controls.detail = props;
      controls.renders += 1;
      const [instance] = useState(() => ++controls.mounts);
      return (
        <section aria-label="정정 테스트 상세">
          <output data-testid="detail-instance">{instance}</output>
          <p>{props.product.name}</p>
          <output data-testid="detail-bottle">{props.selectedBottleId ?? "전체 병"}</output>
        </section>
      );
    },
  };
});

const OLD = "2026-01-01T00:00:00Z",
  SAVED = "2026-01-02T00:00:00Z",
  NEWEST = "2026-01-03T00:00:00Z";
const sourceContext: ProductContext = {
  skuId: "sku-a",
  bottleId: "bottle-a",
  tastingId: "tasting-1",
};
const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "u1",
  created_at: OLD,
  updated_at: OLD,
  deleted_at: null,
  ...fields,
});
function corrected(bottleId = "bottle-b", at = SAVED): ContextualTasting {
  const inA = bottleId !== "bottle-b",
    productId = inA ? "product-a" : "product-b",
    skuId = inA ? "sku-a" : "sku-b",
    purchaseId = inA ? "purchase-a" : "purchase-b";
  return {
    id: "tasting-1",
    updated_at: at,
    bottle_id: bottleId,
    sku_id: skuId,
    tasted_on: "2026-01-01",
    poured_ml: 50,
    rating: "4.0",
    nose: null,
    palate: null,
    finish: null,
    note: "보존할 시음",
    place: null,
    companions: null,
    context: {
      product_id: productId,
      product_name: inA ? "제품 A" : "제품 B",
      vintage: inA ? 2020 : 2021,
      age_years: null,
      abv: "40",
      sku_id: skuId,
      volume_ml: inA ? 500 : 750,
    },
    purchase: {
      id: purchaseId,
      updated_at: OLD,
      sku_id: skuId,
      purchased_on: "2026-01-01",
      vendor_id: null,
      vendor_name: null,
      quantity: inA ? 2 : 1,
    },
    bottle: {
      id: bottleId,
      revision: `revision-${bottleId}`,
      purchase_id: purchaseId,
      label_no: bottleId === "bottle-a2" ? 2 : 1,
      status: "open",
      remaining_ml: inA ? 450 : 700,
      opened_on: "2026-01-01",
      finished_on: null,
      deleted_at: null,
    },
  };
}
function Harness() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const read = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("hashchange", read);
    };
  }, []);
  return (
    <ToastProvider>
      <ProductsPage
        selectedProductId={route.productId ?? null}
        context={route}
        onSelectProduct={(productId, context = {}) => {
          controls.navigate(productId, context);
          const next = { view: "products" as const, productId, ...context };
          window.history.pushState(null, "", routeToHash(next));
          setRoute(next);
        }}
        onDeselectProduct={() => setRoute({ view: "products" })}
        onOpenStoreMode={vi.fn()}
      />
    </ToastProvider>
  );
}
async function start() {
  renderWithQuery(<Harness />);
  await screen.findByTestId("detail-instance");
  await waitFor(() => expect(controls.detail?.onCorrectionSavingChange).toBeTypeOf("function"));
  const detail = controls.detail as DetailProps;
  await act(async () => detail.onCorrectionSavingChange?.(true));
  return detail;
}
async function pull(record: ContextualTasting) {
  await act(async () => {
    await db.transaction("rw", db.tasting_session, db.bottle, async () => {
      await db.tasting_session.update(record.id, {
        bottle_id: record.bottle_id,
        sku_id: record.sku_id,
        updated_at: record.updated_at,
      });
      if (record.bottle)
        await db.bottle.update(record.bottle.id, {
          remaining_ml: record.bottle.remaining_ml,
          revision: record.bottle.revision,
          updated_at: record.updated_at,
        });
    });
  });
}
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await activateDatabase("u1");
  for (const table of db.tables) await table.clear();
  controls.detail = null;
  controls.mounts = 0;
  controls.renders = 0;
  controls.navigate.mockClear();
  controls.triggerSync.mockClear();
  await db.product.bulkPut([
    row("product-a", { name: "제품 A", vintage: 2020 }),
    row("product-b", { name: "제품 B", vintage: 2021 }),
  ]);
  await db.sku.bulkPut([
    row("sku-a", { product_id: "product-a", volume_ml: 500 }),
    row("sku-b", { product_id: "product-b", volume_ml: 750 }),
  ]);
  await db.purchase.bulkPut([
    row("purchase-a", {
      sku_id: "sku-a",
      quantity: 2,
      purchased_on: "2026-01-01",
      unit_paid_price: "10000",
      unit_list_price: "10000",
    }),
    row("purchase-b", {
      sku_id: "sku-b",
      quantity: 1,
      purchased_on: "2026-01-01",
      unit_paid_price: "20000",
      unit_list_price: "20000",
    }),
  ]);
  await db.bottle.bulkPut([
    row("bottle-a", {
      purchase_id: "purchase-a",
      label_no: 1,
      status: "open",
      remaining_ml: 450,
      revision: "old-a",
    }),
    row("bottle-a2", {
      purchase_id: "purchase-a",
      label_no: 2,
      status: "open",
      remaining_ml: 500,
      revision: "old-a2",
    }),
    row("bottle-b", {
      purchase_id: "purchase-b",
      label_no: 1,
      status: "open",
      remaining_ml: 750,
      revision: "old-b",
    }),
  ]);
  await db.tasting_session.put(
    row("tasting-1", {
      bottle_id: "bottle-a",
      sku_id: "sku-a",
      tasted_on: "2026-01-01",
      poured_ml: 50,
      rating: "4.0",
      note: "보존할 시음",
    }),
  );
  window.history.replaceState(
    null,
    "",
    routeToHash({ view: "products", productId: "product-a", ...sourceContext }),
  );
  vi.spyOn(tastingsApi, "get").mockResolvedValue(corrected());
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of db.tables) await table.clear();
});

it("정정 pull이 성공 콜백보다 먼저 연결을 옮겨도 저장 중 상세를 보존한 뒤 새 제품으로 이동한다", async () => {
  const detail = await start();
  const instance = screen.getByTestId("detail-instance").textContent,
    renders = controls.renders;
  await pull(corrected());
  await waitFor(() => expect(controls.renders).toBeGreaterThan(renders));
  expect(screen.getByTestId("detail-instance")).toHaveTextContent(instance as string);
  expect(controls.mounts).toBe(1);
  expect(screen.queryByText(/선택한 규격·구매·병·시음이 삭제/)).not.toBeInTheDocument();
  await act(async () => {
    detail.onTastingCorrected?.(corrected());
    detail.onCorrectionSavingChange?.(false);
  });
  await waitFor(() =>
    expect(controls.navigate).toHaveBeenLastCalledWith(
      "product-b",
      expect.objectContaining({ skuId: "sku-b", bottleId: "bottle-b", tastingId: "tasting-1" }),
    ),
  );
});

it("저장 중 같은 제품의 다른 병으로 hash 이동하면 늦은 성공이 새 선택을 덮지 않는다", async () => {
  const detail = await start();
  await act(async () => {
    window.history.pushState(
      null,
      "",
      routeToHash({
        view: "products",
        productId: "product-a",
        skuId: "sku-a",
        bottleId: "bottle-a2",
      }),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(screen.getByTestId("detail-bottle")).toHaveTextContent("bottle-a2"));
  await act(async () => {
    detail.onTastingCorrected?.(corrected());
    detail.onCorrectionSavingChange?.(false);
  });
  await pull(corrected());
  await waitFor(() => expect(screen.getByTestId("detail-bottle")).toHaveTextContent("bottle-a2"));
  expect(controls.navigate).not.toHaveBeenCalled();
  expect(parseHash(window.location.hash).bottleId).toBe("bottle-a2");
});

it("과거 멱등 응답의 대상 대신 최신 GET과 최신 미러가 가리키는 병으로 이동한다", async () => {
  const newest = corrected("bottle-a2", NEWEST);
  vi.mocked(tastingsApi.get).mockResolvedValue(newest);
  const detail = await start();
  await act(async () => {
    detail.onTastingCorrected?.(corrected());
    detail.onCorrectionSavingChange?.(false);
  });
  await waitFor(() => expect(tastingsApi.get).toHaveBeenCalledWith("tasting-1"));
  expect(controls.navigate).not.toHaveBeenCalled();
  await pull(newest);
  await waitFor(() =>
    expect(controls.navigate).toHaveBeenLastCalledWith(
      "product-a",
      expect.objectContaining({ bottleId: "bottle-a2", tastingId: "tasting-1" }),
    ),
  );
});

it("최신 미러를 기다리는 동안 전체 보기로 복구하면 뒤늦은 pull이 다시 이동시키지 않는다", async () => {
  const detail = await start();
  await act(async () => {
    detail.onTastingCorrected?.(corrected());
    detail.onCorrectionSavingChange?.(false);
  });
  expect(await screen.findByRole("button", { name: "정정한 기록 다시 확인" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "제품 전체 보기" }));
  await waitFor(() => expect(parseHash(window.location.hash).tastingId).toBeUndefined());
  const calls = controls.navigate.mock.calls.length;
  await pull(corrected());
  await waitFor(() => expect(screen.getByTestId("detail-bottle")).toHaveTextContent("전체 병"));
  expect(controls.navigate).toHaveBeenCalledTimes(calls);
  expect(parseHash(window.location.hash).productId).toBe("product-a");
});

it("선택한 시음 삭제 뒤 제품·규격·병 맥락을 유지한다", async () => {
  renderWithQuery(<Harness />);
  await screen.findByTestId("detail-instance");
  expect(controls.detail?.onTastingDeleted).toBeTypeOf("function");
  await act(async () => controls.detail?.onTastingDeleted?.(corrected("bottle-a", OLD)));
  await act(async () => {
    await db.tasting_session.update("tasting-1", { deleted_at: SAVED, updated_at: SAVED });
  });
  await waitFor(() =>
    expect(parseHash(window.location.hash)).toMatchObject({
      productId: "product-a",
      skuId: "sku-a",
      bottleId: "bottle-a",
    }),
  );
  expect(parseHash(window.location.hash).tastingId).toBeUndefined();
  expect(screen.queryByText(/선택한 규격·구매·병·시음이 삭제/)).not.toBeInTheDocument();
});

it("홈의 시음 수정 진입 의도를 상세 폼까지 전달한다", async () => {
  window.history.replaceState(
    null,
    "",
    routeToHash({ view: "products", productId: "product-a", ...sourceContext, editTasting: true }),
  );
  renderWithQuery(<Harness />);
  await screen.findByTestId("detail-instance");
  expect(controls.detail?.editTasting).toBe(true);
});

it("인사이트의 구매 근거는 URL에서 검증한 해당 구매를 상세 행까지 전달한다", async () => {
  window.history.replaceState(
    null,
    "",
    routeToHash({ view: "products", productId: "product-a", purchaseId: "purchase-a" }),
  );
  renderWithQuery(<Harness />);
  await screen.findByTestId("detail-instance");
  expect(controls.detail?.selectedPurchaseId).toBe("purchase-a");
  expect(controls.detail?.selectedSkuId).toBe("sku-a");
});
