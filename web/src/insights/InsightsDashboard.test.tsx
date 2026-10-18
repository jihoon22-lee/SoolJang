import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InsightsDashboard } from "@/insights/InsightsDashboard";
import { activateDatabase, db } from "@/sync/db";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "insight-ui",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  deleted_at: null,
  ...fields,
});
beforeEach(async () => {
  await activateDatabase("insight-ui");
  await db.category.bulkPut([
    row("root", { name: "양주" }),
    row("child", { name: "위스키", parent_id: "root" }),
  ]);
  await db.product.put(
    row("p", { name: "합성 위스키", category_id: "child", personal_rating: "5.0" }),
  );
  await db.sku.put(row("s", { product_id: "p", volume_ml: 700 }));
  await db.purchase.put(
    row("pu", { sku_id: "s", quantity: 2, purchased_on: "2026-01-02", unit_paid_price: "10000" }),
  );
  await db.bottle.bulkPut([
    row("open", {
      purchase_id: "pu",
      label_no: 1,
      status: "open",
      opened_on: "2026-01-03",
      remaining_ml: null,
    }),
    row("done", {
      purchase_id: "pu",
      label_no: 2,
      status: "finished",
      finished_on: "2026-02-02",
      remaining_ml: 0,
    }),
  ]);
  await db.tasting_session.put(
    row("t", { sku_id: "s", bottle_id: "open", tasted_on: "2026-02-03", rating: "0.0" }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});
it("기간·하위 주종·현재 상태 필터의 범위를 표시하고 원래 병으로 이동한다", async () => {
  const navigate = vi.fn();
  render(<InsightsDashboard onSelectProduct={navigate} today="2026-03-01" />);
  await screen.findByRole("heading", { name: "지금 보유한 술" });
  await userEvent.clear(screen.getByLabelText("시작일"));
  await userEvent.type(screen.getByLabelText("시작일"), "2026-02-01");
  await userEvent.clear(screen.getByLabelText("종료일"));
  await userEvent.type(screen.getByLabelText("종료일"), "2026-02-28");
  await userEvent.selectOptions(screen.getByLabelText("주종 (하위 포함)"), "root");
  await userEvent.selectOptions(screen.getByLabelText("대상 병의 현재 상태"), "open");
  const period = screen.getByRole("region", { name: "선택 기간의 변화" });
  await waitFor(() =>
    expect(within(period).getByTestId("period-purchased")).toHaveTextContent("0병"),
  );
  expect(within(period).getByTestId("period-finished")).toHaveTextContent("0병");
  expect(screen.getByText(/현재 재고와 제품 총평은 기간에 영향/)).toBeInTheDocument();
  const opened = screen.getByRole("region", { name: "열린 병의 경과" });
  await userEvent.click(within(opened).getByRole("button", { name: /합성 위스키.*1번 병/ }));
  expect(navigate).toHaveBeenCalledWith("p", { skuId: "s", bottleId: "open" });
  expect(within(opened).getByText(/57일/)).toBeInTheDocument();
});
it("오프라인에서도 시음0점과 제품 총평을 구별해 표본과 결측 근거를 보여준다", async () => {
  vi.stubGlobal("navigator", { ...navigator, onLine: false });
  render(<InsightsDashboard onSelectProduct={vi.fn()} today="2026-03-01" />);
  await screen.findByRole("heading", { name: "지금 보유한 술" });
  expect(screen.getByText(/기기에 저장된 기록/)).toBeInTheDocument();
  const ratings = screen.getByRole("region", { name: "평점과 표본" });
  expect(
    within(ratings).getByText("제품 총평", { selector: "strong" }).parentElement,
  ).toHaveTextContent(/5.*1개/);
  expect(
    within(ratings).getByText("시음 평점", { selector: "strong" }).parentElement,
  ).toHaveTextContent(/0.*1회/);
  expect(screen.getByText(/현재 잔량 미기록.*1건/)).toBeInTheDocument();
});

it("같은 SKU의 여러 구매 중 클릭한 가격 근거의 구매 ID로 이동한다", async () => {
  await db.purchase.put(
    row("pu2", { sku_id: "s", quantity: 1, purchased_on: "2026-02-02", unit_paid_price: "12000" }),
  );
  const navigate = vi.fn();
  render(<InsightsDashboard onSelectProduct={navigate} today="2026-03-01" />);
  const prices = await screen.findByRole("region", { name: "같은 규격의 구매 가격" });
  const source = within(prices)
    .getByText(/2026-02-02.*병당 12,000원/)
    .closest("li");
  expect(source).not.toBeNull();
  if (!source) throw new Error("가격 근거 누락");
  await userEvent.click(within(source).getByRole("button"));
  expect(navigate).toHaveBeenCalledWith("p", { skuId: "s", purchaseId: "pu2" });
});
