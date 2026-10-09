import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import { ProductsPage } from "@/pages/ProductsPage";
import type { ProductContext } from "@/router";
import { activateDatabase, db } from "@/sync/db";
import { getProduct } from "@/sync/queries";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";
import fixture from "../../../tests/fixtures/purchase_filter_cases.json";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "u1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...fields,
});
function Harness() {
  const [id, setId] = useState<string | null>(null);
  const [context, setContext] = useState<ProductContext>({});
  return (
    <SyncStatusProvider>
      <ToastProvider>
        <ProductsPage
          selectedProductId={id}
          context={context}
          onSelectProduct={(next, scope = {}) => {
            setId(next);
            setContext(scope);
          }}
          onDeselectProduct={() => setId(null)}
          onOpenStoreMode={vi.fn()}
        />
      </ToastProvider>
    </SyncStatusProvider>
  );
}
beforeEach(async () => {
  sessionStorage.clear();
  localStorage.clear();
  await activateDatabase("u1");
  for (const table of db.tables) await table.clear();
  const dataset = fixture.datasets.find((data) => data.name.startsWith("g07"));
  if (!dataset) throw new Error("G07 missing");
  for (const product of dataset.products) {
    await db.product.put(row(product.product_id, { name: product.name }));
    await db.sku.bulkPut(
      product.skus.map((sku) =>
        row(sku.sku_id, { product_id: product.product_id, volume_ml: sku.volume_ml }),
      ),
    );
    await db.purchase.bulkPut(product.lots.map((lot) => row(lot.purchase_id, { ...lot })));
    await db.bottle.bulkPut(
      product.bottles.map((bottle) => row(bottle.bottle_id, { ...bottle, label_no: 1 })),
    );
  }
  stubRoutes([]);
});
const names = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("button")[0]?.textContent);
it("용량 조건의 가격순서와 상세 선택 조건·전체 이력 전환을 연결한다", async () => {
  renderWithQuery(<Harness />);
  await screen.findByRole("table");
  await userEvent.selectOptions(screen.getByLabelText("정렬"), "avg_paid_price");
  expect(names()).toEqual(["제품 A", "제품 B"]);
  await userEvent.click(screen.getByText("더 많은 필터", { selector: "summary" }));
  await userEvent.type(screen.getByLabelText("구매 용량 (ml)"), "750");
  await waitFor(() => expect(names()).toEqual(["제품 B", "제품 A"]));
  expect(screen.getAllByText("조건에 맞는 구매 평균").length).toBeGreaterThan(0);
  await userEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "제품 A" }));
  await screen.findByRole("button", { name: "선택 조건" });
  const purchases = () => screen.getByRole("table", { name: /구매 이력/ });
  await waitFor(() => expect(within(purchases()).getAllByRole("row")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "전체 구매 이력" }));
  expect(within(purchases()).getAllByRole("row")).toHaveLength(3);
});
it("같은 용량 동시 추가 409는 현재 제품의 기존 SKU를 골라 입력을 보존한다", async () => {
  const productId = "00000000-0000-0000-0000-000000000001";
  const product = await getProduct(productId);
  if (!product) throw new Error("product missing");
  const sku = {
    id: "raced-sku",
    volume_ml: 500,
    barcode: null,
    barcode_type: null,
    package_note: null,
  };
  const { calls } = stubRoutes([
    {
      match: `/products/${productId}/skus`,
      method: "POST",
      status: 409,
      body: { detail: "같은 용량이 있습니다" },
    },
    { match: `/products/${productId}`, body: { ...product, skus: [...product.skus, sku] } },
  ]);
  renderWithQuery(<Harness />);
  await userEvent.click(
    within(await screen.findByRole("table")).getByRole("button", { name: "제품 A" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "구매 추가" }));
  await userEvent.type(screen.getByLabelText("구매처"), "합성 매장");
  await userEvent.click(screen.getByRole("button", { name: "다른 용량 추가" }));
  await userEvent.type(screen.getByLabelText("용량 (ml)"), "500");
  await userEvent.click(screen.getByRole("button", { name: "규격 추가" }));
  await waitFor(() => expect(screen.getByLabelText("규격")).toHaveValue("raced-sku"));
  expect(screen.getByLabelText("구매처")).toHaveValue("합성 매장");
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
