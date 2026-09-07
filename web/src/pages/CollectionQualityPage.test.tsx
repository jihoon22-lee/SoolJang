import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CollectionQualityPage } from "@/pages/CollectionQualityPage";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";

it("가격 누락의 제품으로 이동하며 미리보기만으로 기록을 바꾸지 않는다", async () => {
  const { calls } = stubRoutes([
    {
      match: "/collection/quality",
      body: {
        items: [
          { kind: "product", id: "p1", name: "합성 술", reason: "category", product_id: "p1" },
        ],
        duplicate_candidates: [],
        coverage: {
          purchases: 2,
          known_price_purchases: 1,
          unknown_price_purchases: 1,
          known_paid_total: "0.00",
          skus: 1,
          unknown_volume_skus: 0,
          unassigned_stock_bottles: 2,
        },
        rules: "0원과 가격 미상을 구분합니다.",
      },
    },
    { match: "/categories/tree", body: { items: [], max_depth: 1, depth_limit: 5 } },
    { match: "/vendors", body: [] },
    {
      match: "/collection/cleanup/preview",
      method: "POST",
      body: {
        id: "preview",
        kind: "product_category",
        confirmed: false,
        snapshot: {
          rows: [{ id: "p1", name: "합성 술" }],
          target: null,
          affected_count: 1,
          bottle_count: 0,
          known_paid_total: "0.00",
          unknown_price_count: 0,
        },
      },
    },
  ]);
  const onSelectProduct = vi.fn();
  renderWithQuery(
    <SyncStatusProvider>
      <CollectionQualityPage onSelectProduct={onSelectProduct} />
    </SyncStatusProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: "해당 제품 확인" }));
  expect(onSelectProduct).toHaveBeenCalledWith("p1");
  await userEvent.click(screen.getByRole("checkbox", { name: "합성 술" }));
  await userEvent.click(screen.getByRole("button", { name: "영향 미리보기 (1건)" }));
  expect(await screen.findByRole("button", { name: "확인하고 정리" })).toBeInTheDocument();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.some((call) => call.url.includes("/confirm"))).toBe(false);
});
