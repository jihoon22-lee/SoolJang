import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, bottlesApi, productsApi, tastingsApi } from "@/api/client";
import type {
  BottleCorrectionContext,
  ContextualTasting,
  Product,
  ProductSkuContext,
  TastingCorrectionInput,
} from "@/api/types";
import { TastingCorrectionForm } from "@/components/TastingCorrectionForm";
import { getCorrectionBlockReason, submitTastingCorrection } from "@/sync/corrections";
import { activateDatabase, db } from "@/sync/db";
import { getLocalTasting } from "@/sync/tastingHistory";

vi.mock("@/sync/corrections", () => ({
  getCorrectionBlockReason: vi.fn(),
  submitTastingCorrection: vi.fn(),
}));
vi.mock("@/sync/tastingHistory", () => ({ getLocalTasting: vi.fn() }));
const TIME = "2026-01-10T10:00:00Z";
function bottle(id: string, volume: number, remaining: number): BottleCorrectionContext {
  return {
    context: {
      product_id: `product-${id}`,
      product_name: "같은 이름",
      vintage: id === "a" ? 2020 : 2021,
      age_years: null,
      abv: "40",
      sku_id: `sku-${id}`,
      volume_ml: volume,
    },
    purchase: {
      id: `purchase-${id}`,
      updated_at: TIME,
      sku_id: `sku-${id}`,
      purchased_on: "2026-01-01",
      vendor_id: null,
      vendor_name: "합성 매장",
      quantity: 1,
    },
    bottle: {
      id,
      revision: `revision-${id}`,
      purchase_id: `purchase-${id}`,
      label_no: 1,
      status: "open",
      remaining_ml: remaining,
      opened_on: "2026-01-01",
      finished_on: null,
      deleted_at: null,
    },
  };
}
let a: BottleCorrectionContext, b: BottleCorrectionContext, tasting: ContextualTasting;
let get: ReturnType<typeof vi.spyOn>,
  target: ReturnType<typeof vi.spyOn>,
  skuProduct: ReturnType<typeof vi.spyOn>;
function productFor(context: ProductSkuContext, volume = context.volume_ml): Product {
  return {
    id: context.product_id,
    name: context.product_name,
    vintage: context.vintage,
    age_years: context.age_years,
    abv: context.abv,
    skus: [
      {
        id: context.sku_id,
        volume_ml: volume,
        barcode: null,
        barcode_type: null,
        package_note: null,
      },
    ],
  } as Product;
}
const saved = vi.fn(),
  cancelled = vi.fn(),
  saving = vi.fn();
function view(offline = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props = {
    tastingId: tasting.id,
    offline,
    bottleOptions: [a, b],
    skuOptions: [a.context, b.context],
    onSaved: saved,
    onCancel: cancelled,
    onSavingChange: saving,
  };
  const rendered = render(
    <QueryClientProvider client={client}>
      <TastingCorrectionForm {...props} />
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}
async function ready() {
  await screen.findByLabelText("시음 메모");
  await waitFor(() => expect(screen.getByRole("button", { name: "정정 저장" })).toBeEnabled());
}
async function chooseB() {
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await waitFor(() => expect(screen.getByRole("button", { name: "정정 저장" })).toBeEnabled());
}
function lastInput(): TastingCorrectionInput {
  return vi.mocked(submitTastingCorrection).mock.calls.at(-1)?.[1] as TastingCorrectionInput;
}
beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("u1");
  vi.clearAllMocks();
  a = bottle("a", 500, 450);
  b = bottle("b", 750, 750);
  tasting = {
    id: "t1",
    updated_at: TIME,
    bottle_id: "a",
    sku_id: "sku-a",
    tasted_on: "2026-01-02",
    poured_ml: 50,
    rating: "4.0",
    nose: "향",
    palate: null,
    finish: null,
    note: "보존할 메모",
    place: "집",
    companions: null,
    ...a,
  };
  get = vi.spyOn(tastingsApi, "get").mockImplementation(async () => structuredClone(tasting));
  target = vi
    .spyOn(bottlesApi, "correctionContext")
    .mockImplementation(async (id) => structuredClone(id === "a" ? a : b));
  skuProduct = vi
    .spyOn(productsApi, "get")
    .mockImplementation(async (id) =>
      productFor(id === a.context.product_id ? a.context : b.context),
    );
  vi.spyOn(tastingsApi, "attachments").mockResolvedValue([
    {
      id: "attachment1",
      kind: "tasting",
      original_filename: "합성 시음 사진.png",
      content_type: "image/png",
      byte_size: 123,
      caption: null,
      product_id: null,
      bottle_id: null,
      tasting_session_id: "t1",
    },
  ]);
  vi.spyOn(tastingsApi, "history").mockResolvedValue([]);
  vi.mocked(getLocalTasting).mockResolvedValue(tasting);
  vi.mocked(getCorrectionBlockReason).mockResolvedValue(null);
  vi.mocked(submitTastingCorrection).mockImplementation(async () => tasting);
});
afterEach(async () => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

it("다른 판본의 대상 병으로 기록만 이동하면 양쪽 잔량을 변경하지 않고 같은 시음과 메모를 보낸다", async () => {
  view();
  await ready();
  await chooseB();
  expect(screen.getByLabelText("정정할 대상 병")).toHaveTextContent("2021 빈티지");
  expect(screen.getByLabelText("기록만 정정하고 현재 상태·잔량 유지")).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(vi.mocked(submitTastingCorrection).mock.calls[0]?.[0]).toBe("t1");
  expect(lastInput()).toMatchObject({
    expected_updated_at: TIME,
    remaining_mode: "preserve",
    final_bottles: [],
    changes: { bottle_id: "b", sku_id: "sku-b", poured_ml: 50, note: "보존할 메모" },
    expected_bottles: [
      { id: "a", revision: "revision-a" },
      { id: "b", revision: "revision-b" },
    ],
  });
});

it("G09 원래 병 500ml와 대상 병 700ml를 명시적으로 확인해 양쪽 최종 상태를 보낸다", async () => {
  view();
  await ready();
  await chooseB();
  await userEvent.click(screen.getByLabelText("명시한 최종 상태·잔량으로 함께 정정"));
  const origin = screen.getByRole("group", { name: /원래 병 · 같은 이름/ });
  const destination = screen.getByRole("group", { name: /대상 병 · 같은 이름/ });
  await userEvent.clear(within(origin).getByLabelText("적용할 최종 잔량 (ml)"));
  await userEvent.type(within(origin).getByLabelText("적용할 최종 잔량 (ml)"), "500");
  await userEvent.clear(within(destination).getByLabelText("적용할 최종 잔량 (ml)"));
  await userEvent.type(within(destination).getByLabelText("적용할 최종 잔량 (ml)"), "700");
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().final_bottles).toEqual([
    expect.objectContaining({ id: "a", remaining_ml: 500, status: "open" }),
    expect.objectContaining({ id: "b", remaining_ml: 700, status: "open" }),
  ]);
});

it("같은 병의 양을 정정할 때 현재 잔량으로 과거 시음량을 제한하거나 병 guard를 중복하지 않는다", async () => {
  a.bottle.remaining_ml = 20;
  tasting.bottle = a.bottle;
  view();
  await ready();
  expect(screen.getByRole("button", { name: "100ml" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "100ml" }));
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().expected_bottles).toHaveLength(1);
  expect(lastInput().changes.poured_ml).toBe(100);
  expect(lastInput().final_bottles).toEqual([]);
});

it("병 연결을 해제하면 명시한 규격과 확인 용량을 전송한다", async () => {
  view();
  await ready();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await waitFor(() => expect(screen.getByRole("button", { name: "정정 저장" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).toMatchObject({
    changes: { bottle_id: null, sku_id: "sku-b" },
    target_sku_expected_volume_ml: 750,
    expected_bottles: [{ id: "a", revision: "revision-a" }],
  });
});

it("병 없는 시음도 서버에서 목표 규격을 읽고 병 guard 없이 확인한 용량을 보낸다", async () => {
  tasting.bottle_id = null;
  tasting.bottle = null;
  tasting.purchase = null;
  view();
  await ready();
  expect(skuProduct).toHaveBeenCalledWith("product-a", expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).toMatchObject({
    changes: { bottle_id: null, sku_id: "sku-a" },
    expected_bottles: [],
    target_sku_expected_volume_ml: 500,
  });
});

it("목표 규격의 용량과 판본이 로컬 선택지와 다르면 최신 맥락을 보여주고 명시적 확인 전 저장하지 않는다", async () => {
  skuProduct.mockImplementation(async (id: string) =>
    id === "product-b"
      ? { ...productFor(b.context, 375), vintage: 2022, abv: "43" }
      : productFor(a.context),
  );
  view();
  await ready();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await screen.findByText(/선택한 규격의 용량 또는 판본 정보가 바뀌었습니다/);
  expect(screen.getByText(/확인한 목표 규격:/)).toHaveTextContent("2022 빈티지 · 43% · 375ml");
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  const review = await screen.findByRole("region", { name: "다시 확인한 최신 상태" });
  expect(review).toHaveTextContent("정정할 목표 규격: 같은 이름 · 2022 빈티지 · 43% · 375ml");
  await userEvent.click(
    within(review).getByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).toMatchObject({
    changes: { bottle_id: null, sku_id: "sku-b" },
    target_sku_expected_volume_ml: 375,
  });
});

it("사용하지 않던 목표 SKU 용량 충돌 뒤 재확인하면 새 서버 용량으로 새 요청을 보낸다", async () => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new ApiError(409, "SKU 용량 변경"));
  view();
  await ready();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await waitFor(() => expect(screen.getByRole("button", { name: "정정 저장" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await screen.findByText(/기록 또는 병이 다른 곳에서 변경/);
  const previous = lastInput();
  expect(previous.target_sku_expected_volume_ml).toBe(750);
  skuProduct.mockImplementation(async (id: string) =>
    productFor(id === "product-b" ? b.context : a.context, id === "product-b" ? 375 : 500),
  );
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  const confirm = await screen.findByRole("button", { name: "이 최신 상태로 정정 다시 확인" });
  expect(screen.getByText(/정정할 목표 규격:/)).toHaveTextContent("375ml");
  await userEvent.click(confirm);
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().target_sku_expected_volume_ml).toBe(375);
  expect(lastInput().request_id).not.toBe(previous.request_id);
});

it("목표 SKU가 삭제되면 새로 조회하거나 재확인해도 이전 선택지를 저장하지 않는다", async () => {
  skuProduct.mockImplementation(async (id: string) =>
    id === "product-b" ? { ...productFor(b.context), skus: [] } : productFor(a.context),
  );
  view();
  await ready();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await screen.findByText(/선택한 규격이 삭제되었거나/);
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모");
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("응답 유실 뒤 재열어도 같은 request_id와 고정된 payload로 재확인한다", async () => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new Error("응답 유실"));
  const first = view();
  await ready();
  await chooseB();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await screen.findByText("응답 유실");
  const input = structuredClone(lastInput());
  first.unmount();
  tasting.updated_at = "2026-01-11T10:00:00Z";
  a.bottle.revision = "new-revision";
  view();
  const retry = await screen.findByRole("button", { name: "같은 요청 다시 확인" });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).toEqual(input);
  expect(Object.keys(localStorage).filter((key) => key.includes("tasting-correction:t1"))).toEqual(
    [],
  );
});

it("409 뒤 입력을 보존하고 최신 상태의 명시적 재확인 후 새 request_id로 저장한다", async () => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new ApiError(409, "충돌"));
  view();
  await ready();
  await userEvent.clear(screen.getByLabelText("시음 메모"));
  await userEvent.type(screen.getByLabelText("시음 메모"), "고칠 메모");
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await screen.findByText(/기록 또는 병이 다른 곳에서 변경/);
  const previous = lastInput().request_id;
  expect(screen.getByLabelText("시음 메모")).toHaveValue("고칠 메모");
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  tasting.updated_at = "2026-01-12T10:00:00Z";
  a.bottle.revision = "revision-new";
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  const confirm = await screen.findByRole("button", {
    name: "이 최신 상태로 정정 다시 확인",
  });
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  await userEvent.click(confirm);
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().request_id).not.toBe(previous);
  expect(lastInput()).toMatchObject({
    expected_updated_at: tasting.updated_at,
    changes: { note: "고칠 메모" },
    expected_bottles: [{ id: "a", revision: "revision-new" }],
  });
});

it("관련 outbox 실패가 있으면 이유를 보여주고 초안을 남긴다", async () => {
  vi.mocked(getCorrectionBlockReason).mockResolvedValue("동기화 실패를 먼저 확인하세요");
  view();
  await screen.findByLabelText("시음 메모");
  await userEvent.type(screen.getByLabelText("시음 메모"), " 추가");
  expect(await screen.findByText("동기화 실패를 먼저 확인하세요")).toBeVisible();
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
  expect(Object.values(localStorage).join(" ")).toContain("보존할 메모 추가");
});

it("저장 중 입력·취소·중복 제출을 막고 계정 전환 뒤 늦은 성공을 무시한다", async () => {
  let finish!: (value: ContextualTasting) => void;
  vi.mocked(submitTastingCorrection).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  view();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  expect(screen.getByLabelText("시음 메모")).toBeDisabled();
  expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
  await activateDatabase("u2");
  await act(async () => finish(tasting));
  expect(saved).not.toHaveBeenCalled();
  expect(Object.values(localStorage).join(" ")).toContain("보존할 메모");
});

it("오프라인에서도 저장한 기록으로 초안을 편집하며 정정 전송만 막는다", async () => {
  onlineManager.setOnline(false);
  view(true);
  await screen.findByLabelText("시음 메모");
  await userEvent.type(screen.getByLabelText("시음 메모"), " 오프라인");
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  expect(get).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
  expect(Object.values(localStorage).join(" ")).toContain("오프라인");
});

it("대상 병 조회 실패 시 이전 병 snapshot을 대신 사용하지 않고 입력을 보존한다", async () => {
  target.mockRejectedValue(new Error("조회 실패"));
  view();
  await ready();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await screen.findByRole("button", { name: "대상 병 다시 확인" });
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모");
});

it("첨부 파일의 기존 연결을 표시하고 정정 payload에 첨부 교체를 넣지 않는다", async () => {
  view();
  await ready();
  await userEvent.click(screen.getByText("시음 첨부", {}));
  expect(await screen.findByText("합성 시음 사진.png")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).not.toHaveProperty("attachments");
});

it("제출 전 초안을 재열 때 병 revision이 달라졌으면 입력을 보존하고 재확인을 요구한다", async () => {
  const first = view();
  await ready();
  await userEvent.click(screen.getByLabelText("명시한 최종 상태·잔량으로 함께 정정"));
  const remaining = screen.getByLabelText("적용할 최종 잔량 (ml)");
  await userEvent.clear(remaining);
  await userEvent.type(remaining, "500");
  first.unmount();
  a.bottle.revision = "other-device-revision";
  a.bottle.remaining_ml = 400;
  view();
  await screen.findByLabelText("시음 메모");
  expect(screen.getByLabelText("적용할 최종 잔량 (ml)")).toHaveValue(500);
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  expect(screen.getByText(/최신 기록과 병 상태를 확인한 뒤 다시 승인/)).toBeVisible();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("응답 유실 후 입력을 바꾸면 새 확인과 새 request_id가 필요하다", async () => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new Error("응답 유실"));
  view();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await screen.findByText("응답 유실");
  const firstId = lastInput().request_id;
  await userEvent.type(screen.getByLabelText("시음 메모"), " 새 입력");
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().request_id).not.toBe(firstId);
  expect(lastInput().changes.note).toBe("보존할 메모 새 입력");
});

it("이전 폼의 늦은 성공은 다시 연 폼의 새 초안을 지우거나 닫지 않는다", async () => {
  let finish!: (value: ContextualTasting) => void;
  vi.mocked(submitTastingCorrection).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = view();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  first.unmount();
  view();
  await screen.findByLabelText("시음 메모");
  await userEvent.type(screen.getByLabelText("시음 메모"), " 나중 입력");
  await act(async () => finish(tasting));
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모 나중 입력");
  expect(Object.values(localStorage).join(" ")).toContain("나중 입력");
});

it("손상되거나 다른 시음의 저장된 정정 초안을 실행하지 않고 그대로 보관한다", async () => {
  const first = view();
  await ready();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 초안");
  first.unmount();
  const key = Object.keys(localStorage).find((key) =>
    key.includes("tasting-correction:t1:data"),
  ) as string;
  const stored = JSON.parse(localStorage.getItem(key) as string);
  const badDraft = JSON.parse(stored.value);
  badDraft.tastingId = "different-tasting";
  stored.value = JSON.stringify(badDraft);
  localStorage.setItem(key, JSON.stringify(stored));
  const preserved = localStorage.getItem(key);
  view();
  await screen.findByText(/저장된 정정 초안의 형식을 확인할 수 없습니다/);
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  expect(localStorage.getItem(key)).toBe(preserved);
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("최신 상태 재조회가 실패하면 확인 전 저장을 막고 입력을 남긴다", async () => {
  view();
  await ready();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 유지");
  get.mockRejectedValueOnce(new Error("최신 조회 실패"));
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await screen.findByText("최신 조회 실패");
  expect(screen.getByRole("button", { name: "정정 저장" })).toBeDisabled();
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모 유지");
});

it("대상 병 조회 실패 뒤 명시적 최신 상태 확인에 성공하면 새 snapshot으로 저장할 수 있다", async () => {
  target.mockRejectedValueOnce(new Error("대상 조회 실패"));
  view();
  await ready();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await screen.findByRole("button", { name: "대상 병 다시 확인" });
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "정정 저장" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().changes.bottle_id).toBe("b");
});

it("대상 병만 정정할 때 기존 노트의 공백과 줄바꿈을 그대로 보존한다", async () => {
  tasting.note = "  첫 줄\n둘째 줄  ";
  tasting.nose = "  기존 향  ";
  view();
  await ready();
  await chooseB();
  await userEvent.click(screen.getByRole("button", { name: "정정 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().changes.note).toBe(tasting.note);
  expect(lastInput().changes.nose).toBe(tasting.nose);
});
