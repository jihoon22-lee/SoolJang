import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CollectionQualityPage } from "@/pages/CollectionQualityPage";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";

it("분류 누락의 제품으로 이동하며 미리보기만으로 기록을 바꾸지 않는다", async () => {
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
          known_price_purchases: 2,
          unknown_price_purchases: 2,
          known_paid_total: "0.00",
          skus: 1,
          unknown_volume_skus: 0,
          unassigned_stock_bottles: 2,
        },
        rules: "구매 가격 공란은 선물·포인트 구매 등의 0원으로 포함합니다.",
      },
    },
    {
      match: "/categories",
      body: {
        items: [
          {
            id: "c1",
            parent_id: null,
            name: "위스키",
            path: ["위스키"],
            depth: 1,
            product_count: 0,
            sort_order: 0,
          },
        ],
        max_depth: 1,
        depth_limit: 5,
      },
    },
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
  await userEvent.click(await screen.findByRole("button", { name: "제품 보기" }));
  expect(onSelectProduct).toHaveBeenCalledWith("p1");
  expect(screen.queryByText(/가격 미상/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("checkbox", { name: "합성 술" }));
  await userEvent.selectOptions(screen.getByLabelText("정할 주종"), "c1");
  await userEvent.click(screen.getByRole("button", { name: "영향 미리보기" }));
  expect(await screen.findByRole("button", { name: "확인하고 정리" })).toBeInTheDocument();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.some((call) => call.url.includes("/confirm"))).toBe(false);
});

it("이름 없는 구매는 제품·날짜·병수로 보이고 구매처 중복은 한쪽으로 합칠 미리보기를 만든다", async () => {
  const { calls } = stubRoutes([
    {
      match: "/collection/quality",
      body: {
        items: [
          {
            kind: "purchase",
            id: "pu1",
            name: null,
            label: "합성 술 · 2026-09-01 · 2병",
            reason: "vendor",
            product_id: "p1",
          },
        ],
        duplicate_candidates: [
          {
            kind: "vendor",
            items: [
              { id: "v1", name: "이마트" },
              { id: "v2", name: "이 마트" },
            ],
          },
        ],
        coverage: {
          purchases: 1,
          known_price_purchases: 1,
          unknown_price_purchases: 0,
          zero_paid_purchases: 1,
          known_paid_total: "0.00",
          skus: 1,
          unknown_volume_skus: 0,
          unassigned_stock_bottles: 0,
        },
        rules: "규칙",
      },
    },
    { match: "/categories/tree", body: { items: [], max_depth: 1, depth_limit: 5 } },
    { match: "/vendors", body: [] },
    {
      match: "/collection/cleanup/preview",
      method: "POST",
      body: {
        id: "merge",
        kind: "vendor_merge",
        confirmed: false,
        snapshot: {
          rows: [{ id: "v2", name: "이 마트" }],
          target: { name: "이마트" },
          affected_count: 0,
          bottle_count: 0,
          known_paid_total: "0.00",
          unknown_price_count: 0,
        },
      },
    },
  ]);
  renderWithQuery(
    <SyncStatusProvider>
      <CollectionQualityPage onSelectProduct={vi.fn()} />
    </SyncStatusProvider>,
  );

  expect(
    await screen.findByRole("checkbox", { name: "합성 술 · 2026-09-01 · 2병" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/0원 1건 포함/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: '"이마트"(으)로 합치기' }));

  expect(await screen.findByRole("button", { name: "확인하고 정리" })).toBeInTheDocument();
  const preview = calls.find((call) => call.url.includes("/cleanup/preview"));
  expect(preview?.body).toEqual({ kind: "vendor_merge", ids: ["v2"], target_id: "v1" });
});
