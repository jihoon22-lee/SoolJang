import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { activateDatabase, databaseIdentity, db } from "@/sync/db";
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
function view(offline = false, existingClient?: QueryClient) {
  const client =
    existingClient ??
    new QueryClient({
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
  await waitFor(() => expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeEnabled());
}
async function chooseB() {
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await waitFor(() =>
    expect(
      screen.getByLabelText("이번 편집의 고급 변경과 현재 병 상태 적용을 확인했습니다"),
    ).toBeEnabled(),
  );
}
async function applyAdvanced() {
  await openAdvanced();
  const approval = screen.getByLabelText(
    "이번 편집의 고급 변경과 현재 병 상태 적용을 확인했습니다",
  );
  await waitFor(() => expect(approval).toBeEnabled());
  if (!(approval as HTMLInputElement).checked) await userEvent.click(approval);
  await userEvent.click(screen.getByRole("button", { name: "고급 정정 적용" }));
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

it("캐시된 시음의 병 버전 대신 창을 다시 연 뒤 확인한 최신 병 버전으로 정정한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const identity = databaseIdentity();
  client.setQueryData(
    ["tastings", "correction", identity.userId, identity.generation, tasting.id, "server"],
    structuredClone(tasting),
  );
  const fresh = structuredClone(tasting);
  if (!fresh.bottle) throw new Error("병 fixture 필요");
  fresh.bottle.revision = "revision-after-later-tastings";
  fresh.bottle.remaining_ml = 400;
  let resolveRead!: (value: ContextualTasting) => void;
  get.mockImplementationOnce(
    () =>
      new Promise<ContextualTasting>((resolve) => {
        resolveRead = resolve;
      }),
  );
  view(false, client);
  expect(screen.queryByLabelText("시음 메모")).not.toBeInTheDocument();
  await act(async () => resolveRead(fresh));
  await ready();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 수정");
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().expected_bottles).toEqual([
    { id: "a", revision: "revision-after-later-tastings" },
  ]);
});

it("최초 최신 조회가 실패하면 캐시로 정정 폼을 열지 않고 재조회 뒤 연다", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const identity = databaseIdentity();
  client.setQueryData(
    ["tastings", "correction", identity.userId, identity.generation, tasting.id, "server"],
    structuredClone(tasting),
  );
  get.mockRejectedValueOnce(new Error("합성 조회 실패"));
  view(false, client);
  await screen.findByText("정정할 기록을 확인하지 못했습니다. 저장된 입력은 유지됩니다.");
  expect(screen.queryByLabelText("시음 메모")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "기록 다시 확인" }));
  await ready();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("대상 병을 다시 고르면 캐시의 과거 버전 대신 최초 최신 조회 결과를 승인 기준으로 쓴다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  client.setQueryData(["bottles", "correction", "u1", "b"], structuredClone(b));
  const fresh = structuredClone(b);
  fresh.bottle.revision = "revision-b-after-other-tasting";
  fresh.bottle.remaining_ml = 700;
  let resolveTarget!: (value: BottleCorrectionContext) => void;
  target.mockImplementationOnce(
    () =>
      new Promise<BottleCorrectionContext>((resolve) => {
        resolveTarget = resolve;
      }),
  );
  view(false, client);
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  await act(async () => resolveTarget(fresh));
  await ready();
  await applyAdvanced();
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().expected_bottles).toContainEqual({
    id: "b",
    revision: "revision-b-after-other-tasting",
  });
});

it("다른 판본의 대상 병으로 기록만 이동하면 양쪽 잔량을 변경하지 않고 같은 시음과 메모를 보낸다", async () => {
  view();
  await ready();
  await openAdvanced();
  await chooseB();
  expect(screen.getByLabelText("정정할 대상 병")).toHaveTextContent("2021 빈티지");
  expect(screen.getByLabelText("기록만 정정하고 현재 상태·잔량 유지")).toBeChecked();
  await applyAdvanced();
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
  await openAdvanced();
  await chooseB();
  await userEvent.click(screen.getByLabelText("명시한 최종 상태·잔량으로 함께 정정"));
  const origin = screen.getByRole("group", { name: /원래 병 · 같은 이름/ });
  const destination = screen.getByRole("group", { name: /대상 병 · 같은 이름/ });
  await userEvent.clear(within(origin).getByLabelText("적용할 최종 잔량 (ml)"));
  await userEvent.type(within(origin).getByLabelText("적용할 최종 잔량 (ml)"), "500");
  await userEvent.clear(within(destination).getByLabelText("적용할 최종 잔량 (ml)"));
  await userEvent.type(within(destination).getByLabelText("적용할 최종 잔량 (ml)"), "700");
  await applyAdvanced();
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
  await openAdvanced();
  expect(screen.getByRole("button", { name: "100ml" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "100ml" }));
  await applyAdvanced();
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().expected_bottles).toHaveLength(1);
  expect(lastInput().changes.poured_ml).toBe(100);
  expect(lastInput().final_bottles).toEqual([]);
});

it("병 연결을 해제하면 명시한 규격과 확인 용량을 전송한다", async () => {
  view();
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await waitFor(() => expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeEnabled());
  await applyAdvanced();
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).toMatchObject({
    changes: { bottle_id: null, sku_id: "sku-b" },
    target_sku_expected_volume_ml: 750,
    expected_bottles: [{ id: "a", revision: "revision-a" }],
  });
});

it("병 없는 시음의 일반 저장도 원래 규격의 용량 guard를 유지하며 평점·메모만 보낸다", async () => {
  tasting.bottle_id = null;
  tasting.bottle = null;
  tasting.purchase = null;
  view();
  await ready();
  expect(skuProduct).toHaveBeenCalledWith("product-a", expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).toMatchObject({
    changes: { note: "보존할 메모", rating: "4.0" },
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
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await screen.findByText(/선택한 규격의 용량 또는 판본 정보가 바뀌었습니다/);
  expect(screen.getByText(/확인한 목표 규격:/)).toHaveTextContent("2022 빈티지 · 43% · 375ml");
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  const review = await screen.findByRole("region", { name: "다시 확인한 최신 상태" });
  expect(review).toHaveTextContent("정정할 목표 규격: 같은 이름 · 2022 빈티지 · 43% · 375ml");
  await userEvent.click(
    within(review).getByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
  );
  await applyAdvanced();
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
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await waitFor(() => expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeEnabled());
  await applyAdvanced();
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
  await applyAdvanced();
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
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
  await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
  await screen.findByText(/선택한 규격이 삭제되었거나/);
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
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
  await openAdvanced();
  await chooseB();
  await applyAdvanced();
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
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await screen.findByText(/기록 또는 병이 다른 곳에서 변경/);
  const previous = lastInput().request_id;
  expect(screen.getByLabelText("시음 메모")).toHaveValue("고칠 메모");
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  tasting.updated_at = "2026-01-12T10:00:00Z";
  a.bottle.revision = "revision-new";
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  const confirm = await screen.findByRole("button", {
    name: "이 최신 상태로 정정 다시 확인",
  });
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  await userEvent.click(confirm);
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
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
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
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
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  expect(screen.getByLabelText("시음 메모")).toBeDisabled();
  expect(screen.getByRole("button", { name: "입력 폐기하고 닫기" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "입력 보관하고 닫기" })).toBeDisabled();
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
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  expect(get).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
  expect(Object.values(localStorage).join(" ")).toContain("오프라인");
});

it("대상 병 조회 실패 시 이전 병 snapshot을 대신 사용하지 않고 입력을 보존한다", async () => {
  target.mockRejectedValue(new Error("조회 실패"));
  view();
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await screen.findByRole("button", { name: "대상 병 다시 확인" });
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모");
});

it("첨부 파일의 기존 연결을 표시하고 정정 payload에 첨부 교체를 넣지 않는다", async () => {
  view();
  await ready();
  await userEvent.click(screen.getByText("시음 첨부", {}));
  expect(await screen.findByText("합성 시음 사진.png")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput()).not.toHaveProperty("attachments");
});

it("제출 전 초안을 재열 때 병 revision이 달라졌으면 입력을 보존하고 재확인을 요구한다", async () => {
  const first = view();
  await ready();
  await openAdvanced();
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
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  expect(screen.getByText(/최신 기록과 병 상태를 확인한 뒤 다시 승인/)).toBeVisible();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("응답 유실 요청이 409로 미적용 확인되면 입력을 고치고 최신 상태 승인 후 새 요청을 보낸다", async () => {
  vi.mocked(submitTastingCorrection)
    .mockRejectedValueOnce(new Error("응답 유실"))
    .mockRejectedValueOnce(new ApiError(409, "다른 수정과 충돌"));
  view();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await screen.findByText("응답 유실");
  const firstId = lastInput().request_id;
  expect(screen.getByLabelText("시음 메모")).toBeDisabled();
  expect(screen.getByRole("button", { name: "최신 상태 다시 확인" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "같은 요청 다시 확인" }));
  await screen.findByText(/기록 또는 병이 다른 곳에서 변경/);
  expect(lastInput().request_id).toBe(firstId);
  expect(screen.getByLabelText("시음 메모")).toBeEnabled();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 새 입력");
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
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
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  first.unmount();
  // A newer draft written by an already-open v1.10.0 client must also be preserved.
  const key = Object.keys(localStorage).find((key) =>
    key.includes("tasting-correction:t1:data"),
  ) as string;
  const stored = JSON.parse(localStorage.getItem(key) as string);
  const newer = JSON.parse(stored.value);
  newer.attempt = null;
  stored.value = JSON.stringify(newer);
  localStorage.setItem(key, JSON.stringify(stored));
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
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
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
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모 유지");
});

it("대상 병 조회 실패 뒤 명시적 최신 상태 확인에 성공하면 새 snapshot으로 저장할 수 있다", async () => {
  target.mockRejectedValueOnce(new Error("대상 조회 실패"));
  view();
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await screen.findByRole("button", { name: "대상 병 다시 확인" });
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "이 최신 상태로 정정 다시 확인" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeEnabled());
  await applyAdvanced();
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().changes.bottle_id).toBe("b");
});

it("대상 병만 정정할 때 기존 노트의 공백과 줄바꿈을 그대로 보존한다", async () => {
  tasting.note = "  첫 줄\n둘째 줄  ";
  tasting.nose = "  기존 향  ";
  view();
  await ready();
  await openAdvanced();
  await chooseB();
  await applyAdvanced();
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(lastInput().changes.note).toBe(tasting.note);
  expect(lastInput().changes.nose).toBe(tasting.nose);
});

it("평점과 일반 메모만 짧은 폼에서 수정하고 고급 정정은 접어 둔다", async () => {
  view();
  await ready();
  const advanced = screen.getByText("날짜·양·대상 병·현재 잔량 정정").closest("details");
  expect(advanced).not.toHaveAttribute("open");
  expect(screen.getByLabelText("시음 메모")).toBeVisible();
  expect(screen.getByLabelText("정정할 대상 병")).not.toBeVisible();
  await userEvent.clear(screen.getByLabelText("시음 메모"));
  await userEvent.type(screen.getByLabelText("시음 메모"), "짧게 고친 메모");
  await userEvent.click(screen.getByRole("button", { name: "0점" }));
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput().changes).toEqual({
    note: "짧게 고친 메모",
    rating: "0.0",
  });
  expect(lastInput().remaining_mode).toBe("preserve");
});

it("방금 로컬 저장한 시음도 바로 수정 입력을 시작하고 서버 확인 전 제출은 막는다", async () => {
  get.mockRejectedValue(new ApiError(404, "아직 서버에 없음"));
  vi.mocked(getCorrectionBlockReason).mockResolvedValue("관련 기록에 동기화 대기 변경이 있습니다.");
  view();
  expect(await screen.findByLabelText("시음 메모")).toHaveValue("보존할 메모");
  await userEvent.type(screen.getByLabelText("시음 메모"), " 이어서 수정");
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

async function openAdvanced() {
  const summary = screen.getByText("날짜·양·대상 병·현재 잔량 정정");
  if (!summary.closest("details")?.hasAttribute("open")) await userEvent.click(summary);
}

async function stageAdvancedDraft() {
  await openAdvanced();
  fireEvent.change(screen.getByLabelText("마신 날"), { target: { value: "2026-01-03" } });
  fireEvent.change(screen.getByLabelText("직접 입력(ml)"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("향"), { target: { value: "보관한 다른 향" } });
  await chooseB();
  await userEvent.click(screen.getByLabelText("명시한 최종 상태·잔량으로 함께 정정"));
  const origin = screen.getByRole("group", { name: /원래 병 · 같은 이름/ });
  const destination = screen.getByRole("group", { name: /대상 병 · 같은 이름/ });
  fireEvent.change(within(origin).getByLabelText("적용할 최종 잔량 (ml)"), {
    target: { value: "500" },
  });
  fireEvent.change(within(destination).getByLabelText("적용할 최종 잔량 (ml)"), {
    target: { value: "650" },
  });
}

it.each([
  "preserve",
  "set_final",
])("복원한 고급 초안이 %s여도 일반 저장은 메모와 평점만 제출한다", async (mode) => {
  const first = view();
  await ready();
  await stageAdvancedDraft();
  if (mode === "preserve")
    await userEvent.click(screen.getByLabelText("기록만 정정하고 현재 상태·잔량 유지"));
  first.unmount();
  view();
  await ready();
  await userEvent.clear(screen.getByLabelText("시음 메모"));
  await userEvent.type(screen.getByLabelText("시음 메모"), "메모만 변경");
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput().changes).toEqual({ note: "메모만 변경", rating: "4.0" });
  expect(lastInput().remaining_mode).toBe("preserve");
  expect(lastInput().final_bottles).toEqual([]);
  expect(lastInput().expected_bottles).toEqual([{ id: "a", revision: "revision-a" }]);
});

it("복원한 고급 변경은 자동으로 펼치고 접어도 일반 저장의 제외·폐기를 알린다", async () => {
  const first = view();
  await ready();
  await stageAdvancedDraft();
  first.unmount();
  view();
  await ready();
  const summary = screen.getByText("날짜·양·대상 병·현재 잔량 정정");
  expect(summary.closest("details")).toHaveAttribute("open");
  await userEvent.click(summary);
  expect(screen.getByLabelText("정정할 대상 병")).not.toBeVisible();
  const notice = screen.getByRole("status", { name: "고급 변경 안내" });
  expect(notice).toBeVisible();
  expect(notice).toHaveTextContent("시음 날짜");
  expect(notice).toHaveTextContent("대상 병");
  expect(notice).toHaveTextContent("현재 상태·잔량");
  expect(notice).toHaveTextContent("초안에서 지웁니다");
});

it("입력 보관과 명시적 폐기는 재열기에서 서로 다른 결과를 낸다", async () => {
  const first = view();
  await ready();
  await stageAdvancedDraft();
  cancelled.mockImplementationOnce(() => first.unmount());
  await userEvent.click(screen.getByRole("button", { name: "입력 보관하고 닫기" }));
  const second = view();
  await ready();
  expect(screen.getByLabelText("마신 날")).toHaveValue("2026-01-03");
  expect(screen.getByLabelText("정정할 대상 병")).toHaveValue("b");
  cancelled.mockImplementationOnce(() => second.unmount());
  await userEvent.click(screen.getByRole("button", { name: "입력 폐기하고 닫기" }));
  view();
  await ready();
  expect(screen.getByLabelText("마신 날")).toHaveValue("2026-01-02");
  expect(screen.getByLabelText("정정할 대상 병")).toHaveValue("a");
  expect(screen.getByLabelText("기록만 정정하고 현재 상태·잔량 유지")).toBeChecked();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("응답 미확정 요청은 일반 저장과 폐기를 막고 원래 본문으로 별도 재확인한다", async () => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new Error("응답 유실"));
  const first = view();
  await ready();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 전송한 입력");
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await screen.findByText("응답 유실");
  const input = structuredClone(lastInput());
  first.unmount();
  tasting.updated_at = "2026-01-11T10:00:00Z";
  a.bottle.revision = "new-revision";
  view();
  await screen.findByLabelText("시음 메모");
  expect(screen.getByLabelText("시음 메모")).toBeDisabled();
  expect(screen.getByRole("button", { name: "평점·메모 저장" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "입력 폐기하고 닫기" })).toBeDisabled();
  const retry = screen.getByRole("button", { name: "같은 요청 다시 확인" });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput()).toEqual(input);
});

it("일반 저장의 응답 유실 뒤 적용하지 않은 대상 병이 없어져도 원요청을 재확인한다", async () => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new Error("응답 유실"));
  const first = view();
  await ready();
  await stageAdvancedDraft();
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await screen.findByText("응답 유실");
  const input = structuredClone(lastInput());
  expect(input.changes).toEqual({ note: "보존할 메모", rating: "4.0" });
  first.unmount();
  target.mockRejectedValue(new ApiError(404, "적용하지 않은 대상 병 삭제"));
  view();
  await screen.findByRole("button", { name: "대상 병 다시 확인" });
  const retry = screen.getByRole("button", { name: "같은 요청 다시 확인" });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput()).toEqual(input);
});

it("고급 대상 조회가 실패해도 일반 저장은 실제 원래 병만 검증하고 고급 값을 제외한다", async () => {
  target.mockRejectedValue(new Error("대상 조회 실패"));
  view();
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await screen.findByRole("button", { name: "대상 병 다시 확인" });
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  const summary = screen.getByRole("button", { name: "평점·메모 저장" });
  expect(summary).toBeEnabled();
  await userEvent.click(summary);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput().changes).toEqual({ note: "보존할 메모", rating: "4.0" });
  expect(lastInput().expected_bottles).toEqual([{ id: "a", revision: "revision-a" }]);
});

it("고급 변경은 이번 편집에서 확인해야 적용되며 재열면 이전 확인을 재사용하지 않는다", async () => {
  const first = view();
  await ready();
  await stageAdvancedDraft();
  const approval = screen.getByLabelText(
    "이번 편집의 고급 변경과 현재 병 상태 적용을 확인했습니다",
  );
  const apply = screen.getByRole("button", { name: "고급 정정 적용" });
  expect(approval).not.toBeChecked();
  expect(apply).toBeDisabled();
  await userEvent.click(apply);
  expect(submitTastingCorrection).not.toHaveBeenCalled();
  await userEvent.click(approval);
  expect(apply).toBeEnabled();
  first.unmount();
  view();
  await ready();
  expect(
    screen.getByLabelText("이번 편집의 고급 변경과 현재 병 상태 적용을 확인했습니다"),
  ).not.toBeChecked();
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  await applyAdvanced();
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput()).toMatchObject({
    changes: {
      tasted_on: "2026-01-03",
      poured_ml: 100,
      bottle_id: "b",
      sku_id: "sku-b",
      nose: "보관한 다른 향",
    },
    remaining_mode: "set_final",
    final_bottles: [
      expect.objectContaining({ id: "a", remaining_ml: 500 }),
      expect.objectContaining({ id: "b", remaining_ml: 650 }),
    ],
  });
});

it("고급 확인 뒤 값을 바꾸면 확인이 풀리고 되돌리기는 고급 값만 원래 기록으로 돌린다", async () => {
  view();
  await ready();
  await stageAdvancedDraft();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 새 메모");
  const approval = screen.getByLabelText(
    "이번 편집의 고급 변경과 현재 병 상태 적용을 확인했습니다",
  );
  await userEvent.click(approval);
  fireEvent.change(screen.getByLabelText("마신 날"), { target: { value: "2026-01-04" } });
  expect(approval).not.toBeChecked();
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  await userEvent.click(approval);
  await userEvent.click(screen.getByRole("button", { name: "고급 변경 되돌리기" }));
  expect(approval).not.toBeChecked();
  expect(screen.getByLabelText("마신 날")).toHaveValue("2026-01-02");
  expect(screen.getByLabelText("직접 입력(ml)")).toHaveValue(50);
  expect(screen.getByLabelText("정정할 대상 병")).toHaveValue("a");
  expect(screen.getByLabelText("향")).toHaveValue("향");
  expect(screen.getByLabelText("기록만 정정하고 현재 상태·잔량 유지")).toBeChecked();
  expect(screen.getByLabelText("시음 메모")).toHaveValue("보존할 메모 새 메모");
  expect(screen.queryByRole("status", { name: "고급 변경 안내" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  expect(submitTastingCorrection).not.toHaveBeenCalled();
});

it("고급 입력에 잘못된 양과 비어 있는 날짜가 있어도 일반 저장은 그 값을 검증하거나 제출하지 않는다", async () => {
  view();
  await ready();
  await openAdvanced();
  fireEvent.change(screen.getByLabelText("직접 입력(ml)"), { target: { value: "-1" } });
  fireEvent.change(screen.getByLabelText("마신 날"), { target: { value: "" } });
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput().changes).toEqual({ note: "보존할 메모", rating: "4.0" });
  expect(lastInput().remaining_mode).toBe("preserve");
});

it("적용하지 않는 대상 병의 outbox 실패는 고급 정정만 막고 일반 저장에는 원래 맥락만 사용한다", async () => {
  vi.mocked(getCorrectionBlockReason).mockImplementation(async (_session, ids) =>
    ids.includes("b") ? "대상 병 동기화 실패" : null,
  );
  view();
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await screen.findByText("고급 정정: 대상 병 동기화 실패");
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  const summary = screen.getByRole("button", { name: "평점·메모 저장" });
  expect(summary).toBeEnabled();
  await userEvent.click(summary);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput().expected_bottles).toEqual([{ id: "a", revision: "revision-a" }]);
});

it("응답 미확정 요청이 422로 거절되면 잠금이 풀려 입력을 고치거나 폐기할 수 있다", async () => {
  vi.mocked(submitTastingCorrection)
    .mockRejectedValueOnce(new Error("응답 유실"))
    .mockRejectedValueOnce(new ApiError(422, "요청 적용 거절"));
  view();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await screen.findByText("응답 유실");
  const frozen = structuredClone(lastInput());
  await userEvent.click(screen.getByRole("button", { name: "같은 요청 다시 확인" }));
  await screen.findByText("요청 적용 거절");
  expect(lastInput()).toEqual(frozen);
  expect(screen.getByLabelText("시음 메모")).toBeEnabled();
  expect(screen.getByRole("button", { name: "입력 폐기하고 닫기" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "같은 요청 다시 확인" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("시음 메모"), " 다시 입력");
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput().request_id).not.toBe(frozen.request_id);
  expect(lastInput().changes.note).toBe("보존할 메모 다시 입력");
});

it("일반 저장 중 미적용 대상 병 조회가 늦게 끝나도 제출 초안의 완료 처리를 방해하지 않는다", async () => {
  let resolveTarget!: (value: BottleCorrectionContext) => void;
  let resolveSave!: (value: ContextualTasting) => void;
  target.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveTarget = resolve;
      }),
  );
  vi.mocked(submitTastingCorrection).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
  );
  view();
  await ready();
  await openAdvanced();
  await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "b");
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(submitTastingCorrection).toHaveBeenCalledOnce());
  await act(async () => resolveTarget(structuredClone(b)));
  await act(async () => resolveSave(structuredClone(tasting)));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(Object.keys(localStorage).filter((key) => key.includes("tasting-correction:t1"))).toEqual(
    [],
  );
});

it("고급 입력에서 Enter를 눌러도 일반 저장을 실행하거나 고급 초안을 지우지 않는다", async () => {
  const first = view();
  await ready();
  await openAdvanced();
  fireEvent.change(screen.getByLabelText("마신 날"), { target: { value: "2026-01-03" } });
  await userEvent.clear(screen.getByLabelText("장소"));
  await userEvent.type(screen.getByLabelText("장소"), "다른 장소{Enter}");
  expect(submitTastingCorrection).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
  first.unmount();
  view();
  await ready();
  expect(screen.getByLabelText("마신 날")).toHaveValue("2026-01-03");
  expect(screen.getByLabelText("장소")).toHaveValue("다른 장소");
  expect(screen.getByRole("status", { name: "고급 변경 안내" })).toBeVisible();
});

it.each([
  "병",
  "규격",
])("일반 저장 충돌 후 미적용 고급 대상 %s가 삭제되어도 수정·재열기 뒤 원래 기록만 재승인한다", async (targetKind) => {
  vi.mocked(submitTastingCorrection).mockRejectedValueOnce(new ApiError(409, "원래 병 충돌"));
  const first = view();
  await ready();
  await openAdvanced();
  if (targetKind === "병") await chooseB();
  else {
    await userEvent.selectOptions(screen.getByLabelText("정정할 대상 병"), "");
    await userEvent.selectOptions(screen.getByLabelText("병 없는 시음의 규격"), "sku-b");
    await screen.findByText(/확인한 목표 규격:.*750ml/);
  }
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await screen.findByText(/기록 또는 병이 다른 곳에서 변경/);
  const previous = structuredClone(lastInput());
  expect(previous.changes).toEqual({ note: "보존할 메모", rating: "4.0" });
  await userEvent.type(screen.getByLabelText("시음 메모"), " 최신 확인 뒤 저장");
  first.unmount();
  tasting.updated_at = "2026-01-12T10:00:00Z";
  a.bottle.revision = "revision-after-conflict";
  if (targetKind === "병") target.mockRejectedValue(new ApiError(404, "미적용 병 삭제"));
  else skuProduct.mockRejectedValue(new ApiError(404, "미적용 규격 삭제"));
  view();
  await screen.findByLabelText("시음 메모");
  await screen.findByRole("button", {
    name: targetKind === "병" ? "대상 병 다시 확인" : "목표 규격 다시 확인",
  });
  target.mockClear();
  skuProduct.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "최신 상태 다시 확인" }));
  const confirm = await screen.findByRole("button", { name: "이 최신 상태로 정정 다시 확인" });
  expect(target).not.toHaveBeenCalled();
  expect(skuProduct).not.toHaveBeenCalled();
  await userEvent.click(confirm);
  expect(screen.getByRole("button", { name: "고급 정정 적용" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "평점·메모 저장" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(lastInput()).toMatchObject({
    expected_updated_at: "2026-01-12T10:00:00Z",
    expected_bottles: [{ id: "a", revision: "revision-after-conflict" }],
    changes: { note: "보존할 메모 최신 확인 뒤 저장", rating: "4.0" },
    remaining_mode: "preserve",
    final_bottles: [],
  });
  expect(lastInput().request_id).not.toBe(previous.request_id);
});
