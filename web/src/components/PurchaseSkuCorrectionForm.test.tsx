import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, productsApi, purchasesApi } from "@/api/client";
import type { Product, PurchaseCorrectionContext, PurchaseSkuCorrectionInput } from "@/api/types";
import { PurchaseSkuCorrectionForm } from "@/components/PurchaseSkuCorrectionForm";
import { getCorrectionBlockReason, submitPurchaseSkuCorrection } from "@/sync/corrections";
import { activateDatabase } from "@/sync/db";
import { renderWithQuery } from "@/testing";

vi.mock("@/sync/corrections", () => ({
  getCorrectionBlockReason: vi.fn(),
  submitPurchaseSkuCorrection: vi.fn(),
}));

const context: PurchaseCorrectionContext = {
  context: {
    product_id: "p1",
    product_name: "정정 확인용 와인",
    vintage: 2021,
    age_years: null,
    abv: "13",
    sku_id: "s750",
    volume_ml: 750,
  },
  purchase: {
    id: "q1",
    sku_id: "s750",
    updated_at: "2026-01-01T00:00:00Z",
    volume_ml: 750,
    vendor_id: null,
    vendor_name: null,
    purchased_on: "2025-12-01",
    quantity: 3,
    unit_list_price: "10000",
    unit_paid_price: "9000",
    list_total: "30000",
    paid_total: "27000",
    currency: "KRW",
    fx_rate: null,
    foreign_unit_price: null,
    discount_note: null,
    import_note: null,
    bottle_count: 3,
  },
  bottles: [
    {
      id: "b1",
      revision: "r1",
      purchase_id: "q1",
      label_no: 1,
      status: "open",
      remaining_ml: 600,
      opened_on: "2026-01-01",
      finished_on: null,
      deleted_at: null,
    },
    {
      id: "b2",
      revision: "r2",
      purchase_id: "q1",
      label_no: 2,
      status: "unopened",
      remaining_ml: null,
      opened_on: null,
      finished_on: null,
      deleted_at: null,
    },
    {
      id: "b3",
      revision: "r3",
      purchase_id: "q1",
      label_no: 3,
      status: "finished",
      remaining_ml: 0,
      opened_on: "2026-01-01",
      finished_on: "2026-01-02",
      deleted_at: "2026-01-03T00:00:00Z",
    },
  ],
  tastings: [
    {
      id: "t1",
      bottle_id: "b1",
      sku_id: "s750",
      updated_at: "2026-01-01T01:00:00Z",
      deleted_at: null,
    },
    {
      id: "t2",
      bottle_id: "b3",
      sku_id: "s750",
      updated_at: "2026-01-02T01:00:00Z",
      deleted_at: "2026-01-03T00:00:00Z",
    },
  ],
};
const product = {
  id: "p1",
  skus: [
    { id: "s750", volume_ml: 750 },
    { id: "s500", volume_ml: 500 },
    { id: "s1000", volume_ml: 1000 },
  ],
} as Product;
const props = () => ({
  purchaseId: "q1",
  offline: false,
  onSavingChange: vi.fn(),
  onSaved: vi.fn(),
  onCancel: vi.fn(),
});
beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  await activateDatabase("purchase-correction-owner");
  vi.spyOn(purchasesApi, "correctionContext").mockResolvedValue(structuredClone(context));
  vi.spyOn(productsApi, "get").mockResolvedValue(product);
  vi.mocked(getCorrectionBlockReason).mockReset().mockResolvedValue(null);
  vi.mocked(submitPurchaseSkuCorrection).mockReset().mockResolvedValue(context);
});
async function select(volume = "s1000") {
  await userEvent.selectOptions(await screen.findByLabelText("바꿀 규격"), volume);
}
async function acknowledge() {
  await userEvent.click(
    screen.getByRole("checkbox", { name: "위 구매의 목표 용량과 병별 최종 상태를 확인했습니다." }),
  );
}
async function submit() {
  const button = screen.getByRole("button", {
    name: /^(구매 규격 정정 저장|같은 정정 다시 저장)$/,
  });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}
it("새 용량보다 큰 잔량을 명시해야 하며 삭제된 병·시음까지 guard를 보낸다", async () => {
  const callbacks = props();
  renderWithQuery(<PurchaseSkuCorrectionForm {...callbacks} />);
  await select("s500");
  expect(screen.getByText(/현재 600ml가 새 용량보다 큽니다/)).toBeInTheDocument();
  await acknowledge();
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "1번 병의 최종 상태·잔량도 지정" }));
  fireEvent.change(screen.getByLabelText("적용할 최종 잔량 (ml)"), { target: { value: "450" } });
  await acknowledge();
  await submit();
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  const input = vi.mocked(submitPurchaseSkuCorrection).mock.calls[0]?.[1];
  expect(input).toMatchObject({
    target_sku_id: "s500",
    target_sku_expected_volume_ml: 500,
    expected_bottles: [
      { id: "b1", revision: "r1" },
      { id: "b2", revision: "r2" },
      { id: "b3", revision: "r3" },
    ],
    final_bottles: [
      { id: "b1", status: "open", remaining_ml: 450, opened_on: "2026-01-01", finished_on: null },
    ],
  });
  expect(input?.expected_tastings.map((row) => row.id)).toEqual(["t1", "t2"]);
  expect(Object.keys(localStorage).filter((key) => key.includes("purchase-correction:q1"))).toEqual(
    [],
  );
});
it("잔량 유지와 미개봉 전량 해석을 확인하고 입력하지 않은 상태는 보내지 않는다", async () => {
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  expect(screen.getByText(/새 용량 전량\(1000ml\)/)).toBeInTheDocument();
  await acknowledge();
  await submit();
  expect(vi.mocked(submitPurchaseSkuCorrection).mock.calls[0]?.[1].final_bottles).toEqual([]);
});
it.each([
  "network",
  "502",
  "408",
])("응답 유실(%s) 후 재열기에서도 같은 request ID와 전제조건으로 재시도한다", async (kind) => {
  vi.mocked(submitPurchaseSkuCorrection).mockRejectedValueOnce(
    kind === "network" ? new TypeError("응답 유실") : new ApiError(Number(kind), "응답 유실"),
  );
  const first = renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  await acknowledge();
  await submit();
  expect(await screen.findByText("응답 유실")).toBeInTheDocument();
  const input = vi.mocked(submitPurchaseSkuCorrection).mock.calls[0]?.[1];
  first.unmount();
  const applied = structuredClone(context);
  applied.purchase.sku_id = "s1000";
  applied.purchase.updated_at = "2026-02-01T00:00:00Z";
  applied.context.sku_id = "s1000";
  applied.context.volume_ml = 1000;
  applied.bottles = applied.bottles.map((bottle, i) =>
    i === 0 ? { ...bottle, revision: "after" } : bottle,
  );
  vi.mocked(purchasesApi.correctionContext).mockResolvedValue(applied);
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await screen.findByLabelText("바꿀 규격");
  await acknowledge();
  await submit();
  expect(vi.mocked(submitPurchaseSkuCorrection).mock.calls[1]?.[1]).toEqual(input);
});
it("409 후 초안을 보존하고 명시적 재확인 후 새로운 revision과 요청을 사용한다", async () => {
  vi.mocked(submitPurchaseSkuCorrection).mockRejectedValueOnce(new ApiError(409, "다른 기기 변경"));
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  await acknowledge();
  await submit();
  expect(await screen.findByText("다른 기기 변경")).toBeInTheDocument();
  expect(screen.getByLabelText("바꿀 규격")).toHaveValue("s1000");
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
  const oldInput = vi.mocked(submitPurchaseSkuCorrection).mock.calls[0]?.[1];
  const updated = structuredClone(context);
  updated.bottles = updated.bottles.map((bottle, i) =>
    i === 0 ? { ...bottle, revision: "fresh" } : bottle,
  );
  vi.mocked(purchasesApi.correctionContext).mockResolvedValue(updated);
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await waitFor(() => expect(screen.queryByText("다른 기기 변경")).not.toBeInTheDocument());
  await acknowledge();
  await submit();
  const next = vi.mocked(submitPurchaseSkuCorrection).mock.calls[1]?.[1];
  expect(next?.request_id).not.toBe(oldInput?.request_id);
  expect(next?.expected_bottles[0]?.revision).toBe("fresh");
});
it("제출 전 작성한 초안의 병이 바뀌면 재열기에서 자동으로 새 revision을 채택하지 않는다", async () => {
  const first = renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  first.unmount();
  const updated = structuredClone(context);
  updated.bottles = updated.bottles.map((bottle, i) =>
    i === 0 ? { ...bottle, revision: "changed" } : bottle,
  );
  vi.mocked(purchasesApi.correctionContext).mockResolvedValue(updated);
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await screen.findByText(/다른 변경이 있습니다/);
  await acknowledge();
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
  expect(vi.mocked(submitPurchaseSkuCorrection)).not.toHaveBeenCalled();
});
it("오프라인과 미전송 변경은 입력을 보존하며 저장을 막는다", async () => {
  const callbacks = props();
  const view = renderWithQuery(<PurchaseSkuCorrectionForm {...callbacks} />);
  await select();
  view.rerender(<PurchaseSkuCorrectionForm {...callbacks} offline />);
  expect(screen.getByText(/정정 저장은 온라인에서 가능합니다/)).toBeInTheDocument();
  expect(screen.getByLabelText("바꿀 규격")).toHaveValue("s1000");
  await acknowledge();
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
  view.unmount();
  vi.mocked(getCorrectionBlockReason).mockResolvedValue("실패한 시음 동기화가 남았습니다");
  renderWithQuery(<PurchaseSkuCorrectionForm {...callbacks} />);
  expect(await screen.findByText("실패한 시음 동기화가 남았습니다")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
});
it("최신 상태 조회 실패는 편집한 용량을 지우지 않는다", async () => {
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  vi.mocked(purchasesApi.correctionContext).mockRejectedValueOnce(new Error("조회 실패"));
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await screen.findByText(/현재 상태를 불러오지 못했습니다/);
  expect(screen.getByLabelText("바꿀 규격")).toHaveValue("s1000");
  await acknowledge();
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
});
it("이전 화면의 성공 응답이 재열린 초안과 현재 계정의 화면을 덮지 않는다", async () => {
  let complete!: (value: PurchaseCorrectionContext) => void;
  vi.mocked(submitPurchaseSkuCorrection).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const callbacks = props();
  const old = renderWithQuery(<PurchaseSkuCorrectionForm {...callbacks} />);
  await select();
  await acknowledge();
  await submit();
  await waitFor(() => expect(submitPurchaseSkuCorrection).toHaveBeenCalledOnce());
  old.unmount();
  const next = props();
  renderWithQuery(<PurchaseSkuCorrectionForm {...next} />);
  await select("s750");
  await act(async () => complete(context));
  expect(callbacks.onSaved).not.toHaveBeenCalled();
  expect(next.onSaved).not.toHaveBeenCalled();
  expect(screen.getByLabelText("바꿀 규격")).toHaveValue("s750");
});
it("최종 상태 입력을 취소하면 그 병의 현재 상태를 유지한다", async () => {
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  const checkbox = screen.getByRole("checkbox", { name: "1번 병의 최종 상태·잔량도 지정" });
  await userEvent.click(checkbox);
  fireEvent.change(screen.getByLabelText("적용할 최종 잔량 (ml)"), { target: { value: "400" } });
  await userEvent.click(checkbox);
  await acknowledge();
  await submit();
  const input = vi.mocked(submitPurchaseSkuCorrection).mock
    .calls[0]?.[1] as PurchaseSkuCorrectionInput;
  expect(input.final_bottles).toEqual([]);
});
it("구매 분할로 이동한 병의 상태 초안은 숨기지 않고 사용자가 해제한다", async () => {
  renderWithQuery(<PurchaseSkuCorrectionForm {...props()} />);
  await select();
  await userEvent.click(screen.getByRole("checkbox", { name: "1번 병의 최종 상태·잔량도 지정" }));
  fireEvent.change(screen.getByLabelText("적용할 최종 잔량 (ml)"), { target: { value: "450" } });
  const split = structuredClone(context);
  split.bottles = split.bottles.filter((bottle) => bottle.id !== "b1");
  split.tastings = split.tastings.filter((tasting) => tasting.bottle_id !== "b1");
  split.purchase.updated_at = "2026-03-01T00:00:00Z";
  vi.mocked(purchasesApi.correctionContext).mockResolvedValue(split);
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  expect(await screen.findByText(/이 구매에서 이동되었거나 사용할 수 없는 병/)).toBeInTheDocument();
  await acknowledge();
  expect(screen.getByRole("button", { name: "구매 규격 정정 저장" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "이동한 병의 최종 상태 입력 해제" }));
  await acknowledge();
  await submit();
  const input = vi.mocked(submitPurchaseSkuCorrection).mock.calls[0]?.[1];
  expect(input?.final_bottles).toEqual([]);
  expect(input?.expected_bottles.map((bottle) => bottle.id)).toEqual(["b2", "b3"]);
});
