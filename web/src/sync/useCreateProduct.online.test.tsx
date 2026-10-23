import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, attachmentsApi, productsApi, purchasesApi, vendorsApi } from "@/api/client";
import type { Product } from "@/api/types";
import { EMPTY_PRODUCT_FORM } from "@/components/ProductForm";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { captureFormDraft } from "@/sync/drafts";
import { PartialProductCreationError, useCreateProduct } from "@/sync/useCreateProduct";
import { creationLabel } from "@/sync/useCreateProductProgress";

const connection = vi.hoisted(() => ({ state: "idle" }));
vi.mock("@/sync/SyncStatusProvider", () => ({
  useSyncStatus: () => ({ state: connection.state, triggerSync: vi.fn() }),
}));

const created = {
  id: "p-online",
  name: "온라인 합성 위스키",
  name_en: null,
  search_aliases: [],
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
  skus: [{ id: "s-online", volume_ml: 700, barcode: null, barcode_type: null, package_note: null }],
  sku_summaries: [],
  created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z",
} as unknown as Product;

async function submit(
  result: { current: ReturnType<typeof useCreateProduct> },
  input: Parameters<ReturnType<typeof useCreateProduct>["mutateAsync"]>[0],
): Promise<string> {
  let saved = "";
  let failure: unknown;
  await act(async () => {
    try {
      saved = await result.current.mutateAsync(input);
    } catch (error) {
      failure = error;
    }
  });
  if (failure) throw failure;
  return saved;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  connection.state = "idle";
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("sooljang-draft-tab", "creation-test-tab");
  await activateDatabase("online-create-owner");
  await db.outbox.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  lockDatabase();
});

it("제품 응답을 잃은 뒤 구매 칸만 고쳐 다시 보내도 제품은 같은 요청으로 돌아온다", async () => {
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue(created);
  const createPurchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });
  const values = {
    ...EMPTY_PRODUCT_FORM,
    name: "온라인 합성 위스키",
    volumeMl: "700",
    quantity: "1",
    unitPaidPrice: "50000",
  };

  await expect(submit(result, { values, labelFile: null })).rejects.toThrow();
  await submit(result, {
    values: { ...values, unitPaidPrice: "48000" },
    labelFile: null,
  });

  const [first, second] = createProduct.mock.calls;
  expect(second?.[0].request_id).toBe(first?.[0].request_id);
  expect(createPurchase).toHaveBeenCalledOnce();
  expect(createPurchase.mock.calls[0]?.[0].request_id).not.toBe(first?.[0].request_id);
});

const purchaseValues = {
  ...EMPTY_PRODUCT_FORM,
  name: "온라인 합성 위스키",
  volumeMl: "700",
  quantity: "1",
  unitPaidPrice: "50000",
};

async function partialFailure(promise: Promise<unknown>): Promise<PartialProductCreationError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PartialProductCreationError);
  return error as PartialProductCreationError;
}

it("구매 응답을 잃은 뒤 병수 변경은 막고 원래 구매 내용과 요청으로 결과를 확인한다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  const failed = await partialFailure(submit(result, { values: purchaseValues, labelFile: null }));
  await expect(
    submit(result, {
      values: { ...purchaseValues, quantity: "2" },
      labelFile: null,
      existingProduct: failed.product,
      purchaseAlreadyCreated: failed.purchaseCreated,
    }),
  ).rejects.toThrow("구매 결과가 미확정");
  expect(createPurchase).toHaveBeenCalledOnce();
  await submit(result, { values: purchaseValues });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0]).toEqual(first?.[0]);
});

it("구매 뒤 라벨 저장이 실패하면 보관한 성공 단계로 재시도해 구매를 다시 만들지 않는다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  vi.spyOn(attachmentsApi, "create")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({} as never);
  const label = new File(["label"], "label.png", { type: "image/png" });
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  await partialFailure(submit(result, { values: purchaseValues, labelFile: label }));
  // 호출자가 성공 단계를 넘기지 않아도 같은 탭에 보관한 구매 성공을 이어 쓴다.
  await submit(result, { values: purchaseValues, labelFile: label });

  expect(createPurchase).toHaveBeenCalledOnce();
});

it("검증 오류는 앞선 시도 결과를 알려 주지 않으므로 고쳐 보내도 같은 요청 식별자를 쓴다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new ApiError(422, "입력 오류"))
    .mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  const failed = await partialFailure(submit(result, { values: purchaseValues, labelFile: null }));
  await submit(result, {
    values: { ...purchaseValues, unitPaidPrice: "48000" },
    labelFile: null,
    existingProduct: failed.product,
  });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0].request_id).toBe(first?.[0].request_id);
});

it("이미 저장됐다는 409 뒤에도 구매 요청을 바꾸어 중복 구매를 만들지 않는다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new ApiError(409, "앞서 보낸 등록이 이미 저장됐습니다"))
    .mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  const failed = await partialFailure(submit(result, { values: purchaseValues, labelFile: null }));
  await submit(result, {
    values: purchaseValues,
    labelFile: null,
    existingProduct: failed.product,
  });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0]).toEqual(first?.[0]);
});

it("제품 응답 유실 뒤 이름을 고쳐도 새 요청으로 풀리지 않고 원래 입력으로 재확인한다", async () => {
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue(created);
  const values = { ...purchaseValues, quantity: "" };
  const first = renderHook(useCreateProduct, { wrapper });
  await expect(submit(first.result, { values })).rejects.toThrow();
  first.unmount();
  const reopened = renderHook(useCreateProduct, { wrapper });
  await expect(
    submit(reopened.result, { values: { ...values, name: "다른 입력" } }),
  ).rejects.toThrow("제품 결과가 미확정");
  expect(createProduct).toHaveBeenCalledOnce();
  expect(reopened.result.current.progress?.values.name).toBe(values.name);
  await submit(reopened.result, { values });
  expect(createProduct.mock.calls[1]?.[0]).toEqual(createProduct.mock.calls[0]?.[0]);
});

it("제품의 확정 409는 요청을 보존한 충돌로 남고 같은 요청을 반복 전송하지 않는다", async () => {
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new ApiError(409, "이미 저장됐습니다"))
    .mockResolvedValue(created);
  const hook = renderHook(useCreateProduct, { wrapper });
  const values = { ...purchaseValues, quantity: "" };
  await expect(submit(hook.result, { values })).rejects.toThrow();
  expect(hook.result.current.progress?.productConflict).toBe(true);
  expect(hook.result.current.progress?.productRequest?.request_id).toBe(
    createProduct.mock.calls[0]?.[0].request_id,
  );
  await expect(submit(hook.result, { values })).rejects.toThrow("충돌");
  expect(createProduct).toHaveBeenCalledOnce();
});

it("ID를 모르는 확정 제품 충돌도 명시적으로 중단한 뒤에만 새 요청으로 작성한다", async () => {
  const create = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new ApiError(409, "앞선 등록 내역을 확인할 수 없습니다"))
    .mockResolvedValue(created);
  const remove = vi.spyOn(productsApi, "remove");
  const values = { ...purchaseValues, quantity: "" };
  const key = "sooljang-draft-v1:online-create-owner:creation-test-tab:product:create";
  localStorage.setItem(key, JSON.stringify({ value: values, revision: "conflict-draft" }));
  const first = renderHook(useCreateProduct, { wrapper });
  await expect(submit(first.result, { values })).rejects.toThrow();
  first.unmount();
  const reopened = renderHook(useCreateProduct, { wrapper });
  expect(reopened.result.current.progress?.product).toBeNull();
  act(() => {
    expect(reopened.result.current.discardCompleted(captureFormDraft("product:create"))).toBe(true);
  });
  expect(reopened.result.current.progress).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  await submit(reopened.result, { values: { ...values, name: "목록 확인 후 의도한 새 술" } });
  expect(create.mock.calls[1]?.[0].request_id).not.toBe(create.mock.calls[0]?.[0].request_id);
});

it("충돌 중단 확인 뒤 바뀐 초안이나 재로그인 세대의 입력은 지우지 않는다", async () => {
  vi.spyOn(productsApi, "create").mockRejectedValue(new ApiError(409, "확정 충돌"));
  const values = { ...purchaseValues, quantity: "" };
  const key = "sooljang-draft-v1:online-create-owner:creation-test-tab:product:create";
  localStorage.setItem(key, JSON.stringify({ value: values, revision: "initial" }));
  const hook = renderHook(useCreateProduct, { wrapper });
  await expect(submit(hook.result, { values })).rejects.toThrow();
  const beforeEdit = captureFormDraft("product:create");
  localStorage.setItem(key, JSON.stringify({ value: values, revision: "newer" }));
  expect(hook.result.current.discardCompleted(beforeEdit)).toBe(false);
  const beforeLogin = captureFormDraft("product:create");
  lockDatabase();
  await activateDatabase("online-create-owner");
  expect(hook.result.current.discardCompleted(beforeLogin)).toBe(false);
  expect(localStorage.getItem(key)).not.toBeNull();
  act(() => {
    expect(hook.result.current.discardCompleted(captureFormDraft("product:create"))).toBe(true);
  });
});

it.each([
  new TypeError("응답 유실"),
  new ApiError(503, "일시 장애"),
])("제품 미확정 오류 %s는 충돌 중단으로 해제할 수 없고 같은 요청으로만 재확인한다", async (error) => {
  const create = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(error)
    .mockResolvedValue(created);
  const hook = renderHook(useCreateProduct, { wrapper });
  const values = { ...purchaseValues, quantity: "" };
  await expect(submit(hook.result, { values })).rejects.toThrow();
  expect(hook.result.current.progress?.productConflict).not.toBe(true);
  expect(hook.result.current.discardCompleted(captureFormDraft("product:create"))).toBe(false);
  connection.state = "offline";
  hook.rerender();
  await expect(submit(hook.result, { values })).rejects.toThrow("온라인");
  expect(await db.outbox.count()).toBe(0);
  connection.state = "idle";
  hook.rerender();
  await submit(hook.result, { values });
  expect(create.mock.calls[1]?.[0].request_id).toBe(create.mock.calls[0]?.[0].request_id);
});

it("앞서 응답을 잃은 요청은 뒤의 422에도 원래 입력으로 묶어 둔다", async () => {
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockRejectedValueOnce(new ApiError(422, "검증 오류"))
    .mockResolvedValue(created);
  const hook = renderHook(useCreateProduct, { wrapper });
  const values = { ...purchaseValues, quantity: "" };
  await expect(submit(hook.result, { values })).rejects.toThrow();
  await expect(submit(hook.result, { values })).rejects.toThrow();
  await expect(submit(hook.result, { values: { ...values, name: "수정한 이름" } })).rejects.toThrow(
    "제품 결과가 미확정",
  );
  expect(createProduct).toHaveBeenCalledTimes(2);
  await submit(hook.result, { values });
  expect(createProduct.mock.calls[2]?.[0]).toEqual(createProduct.mock.calls[0]?.[0]);
});

it("첫 제품 요청의 확정 검증 실패는 내용을 고치되 같은 요청으로 다시 저장한다", async () => {
  const create = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new ApiError(422, "입력 오류"))
    .mockResolvedValue(created);
  const hook = renderHook(useCreateProduct, { wrapper });
  const values = { ...purchaseValues, quantity: "" };
  await expect(submit(hook.result, { values })).rejects.toThrow("입력 오류");
  expect(hook.result.current.progress?.productRequest).toBeNull();
  await submit(hook.result, { values: { ...values, name: "고친 제품명" } });
  expect(create.mock.calls[1]?.[0].name).toBe("고친 제품명");
  expect(create.mock.calls[1]?.[0].request_id).toBe(create.mock.calls[0]?.[0].request_id);
});

it("미확정 구매는 재진입 뒤에도 원래 보낸 구매처 id로 재확인한다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const vendors = vi
    .spyOn(vendorsApi, "list")
    .mockResolvedValue([{ id: "original-vendor", name: "합성 구매처" }] as never);
  const purchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue({} as never);
  const values = { ...purchaseValues, vendorName: "합성 구매처" };
  const first = renderHook(useCreateProduct, { wrapper });
  await partialFailure(submit(first.result, { values }));
  first.unmount();
  vendors.mockResolvedValue([{ id: "different-vendor", name: "합성 구매처" }] as never);
  const reopened = renderHook(useCreateProduct, { wrapper });
  await submit(reopened.result, { values });
  expect(vendors).toHaveBeenCalledOnce();
  expect(purchase.mock.calls[1]?.[0]).toEqual(purchase.mock.calls[0]?.[0]);
});

it("제품 응답 유실 뒤 다른 용량이 먼저 돌아와도 원래 입력한 용량에 구매를 연결한다", async () => {
  vi.spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue({
      ...created,
      skus: [{ ...created.skus[0], id: "new-500ml", volume_ml: 500 }, ...created.skus],
    } as Product);
  const purchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const hook = renderHook(useCreateProduct, { wrapper });
  await expect(submit(hook.result, { values: purchaseValues })).rejects.toThrow();
  await submit(hook.result, { values: purchaseValues });
  expect(purchase.mock.calls[0]?.[0].sku_id).toBe("s-online");
});

it.each([
  ["삭제된", []],
  ["다른 용량만 남은", [{ ...created.skus[0], id: "other-volume", volume_ml: 500 }]],
  ["같은 용량이 여러 개인", [...created.skus, { ...created.skus[0], id: "ambiguous-700ml" }]],
])("제품 복구 응답에서 %s 규격은 구매를 생략하거나 임의 선택하지 않고 입력을 보존한다", async (_kind, skus) => {
  vi.spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue({ ...created, skus } as Product);
  const purchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const key = "sooljang-draft-v1:online-create-owner:creation-test-tab:product:create";
  localStorage.setItem(key, JSON.stringify({ value: purchaseValues, revision: "submitted" }));
  const hook = renderHook(useCreateProduct, { wrapper });
  await expect(submit(hook.result, { values: purchaseValues })).rejects.toThrow();
  await expect(submit(hook.result, { values: purchaseValues })).rejects.toThrow("규격을 확인");
  expect(purchase).not.toHaveBeenCalled();
  expect(hook.result.current.progress?.product?.id).toBe(created.id);
  expect(hook.result.current.progress?.completedId).toBeNull();
  expect(localStorage.getItem(key)).toContain(purchaseValues.name);
});

it("보낸 입력으로 결과를 재확인해도 이후에 보관한 다른 초안은 지우지 않는다", async () => {
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue(created);
  const hook = renderHook(useCreateProduct, { wrapper });
  const values = { ...purchaseValues, quantity: "" };
  await expect(submit(hook.result, { values })).rejects.toThrow();
  const key = "sooljang-draft-v1:online-create-owner:creation-test-tab:product:create";
  const newer = JSON.stringify({ value: { ...values, note: "나중에 쓴 메모" }, revision: "new" });
  localStorage.setItem(key, newer);
  await submit(hook.result, { values });
  expect(localStorage.getItem(key)).toBe(newer);
  expect(hook.result.current.progress?.draftCleared).toBe(false);
  expect(createProduct).toHaveBeenCalledTimes(2);
});

it("제품과 구매 뒤 첨부가 실패해도 오프라인 재시도는 새 제품과 구매를 만들지 않는다", async () => {
  const createProduct = vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  vi.spyOn(attachmentsApi, "create").mockRejectedValue(new TypeError("Failed to fetch"));
  const label = new File(["label"], "label.png", { type: "image/png" });
  const { result, rerender } = renderHook(() => useCreateProduct(), { wrapper });
  const failed = await partialFailure(submit(result, { values: purchaseValues, labelFile: label }));
  expect(failed.purchaseCreated).toBe(true);

  connection.state = "offline";
  rerender();
  await expect(
    submit(result, {
      values: purchaseValues,
      labelFile: label,
      existingProduct: failed.product,
      purchaseAlreadyCreated: failed.purchaseCreated,
    }),
  ).rejects.toThrow("온라인");

  expect(await db.outbox.count()).toBe(0);
  expect(createProduct).toHaveBeenCalledOnce();
  expect(createPurchase).toHaveBeenCalledOnce();
});

it("온라인 제품 응답이 미확정이면 오프라인에서 새 id로 등록하지 않는다", async () => {
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockRejectedValue(new TypeError("Failed to fetch"));
  const { result, rerender } = renderHook(() => useCreateProduct(), { wrapper });
  await expect(submit(result, { values: purchaseValues })).rejects.toThrow();

  connection.state = "offline";
  rerender();
  await expect(submit(result, { values: purchaseValues })).rejects.toThrow("온라인");
  expect(await db.outbox.count()).toBe(0);
  expect(createProduct).toHaveBeenCalledOnce();
});

it("늦은 생성 성공은 이후 바뀐 초안을 보존하고 같은 입력을 신규 생성으로 다시 보내지 않는다", async () => {
  const draftKey = "sooljang-draft-v1:online-create-owner:creation-test-tab:product:create";
  localStorage.setItem(draftKey, JSON.stringify({ value: purchaseValues, revision: "submitted" }));
  let resolve!: (product: Product) => void;
  const createProduct = vi.spyOn(productsApi, "create").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });
  let saving!: Promise<string>;
  act(() => {
    saving = result.current.mutateAsync({ values: purchaseValues });
  });
  await waitFor(() => expect(createProduct).toHaveBeenCalledOnce());
  const newer = { value: { ...purchaseValues, note: "저장 대기 중 추가 메모" }, revision: "newer" };
  localStorage.setItem(draftKey, JSON.stringify(newer));
  await act(async () => {
    resolve(created);
    await saving;
  });

  expect(JSON.parse(localStorage.getItem(draftKey) ?? "null")).toEqual(newer);
  await expect(submit(result, { values: newer.value })).rejects.toThrow("이미 등록");
  expect(createProduct).toHaveBeenCalledOnce();
});

it("폼을 닫았다 다시 열어도 부분 성공과 오프라인 차단을 유지하고 온라인에서 남은 단계만 저장한다", async () => {
  const createProduct = vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const attach = vi
    .spyOn(attachmentsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue({} as never);
  const first = renderHook(useCreateProduct, { wrapper });
  await partialFailure(
    submit(first.result, {
      values: purchaseValues,
      labelFile: new File(["label"], "label.png", { type: "image/png" }),
    }),
  );
  act(() => first.result.current.reset());
  first.unmount();

  connection.state = "offline";
  const reopened = renderHook(useCreateProduct, { wrapper });
  expect(reopened.result.current.progress).toMatchObject({
    product: { id: created.id },
    purchaseCreated: true,
  });
  await expect(submit(reopened.result, { values: purchaseValues })).rejects.toThrow("온라인");
  expect(await db.outbox.count()).toBe(0);
  connection.state = "idle";
  reopened.rerender();
  await submit(reopened.result, { values: purchaseValues });
  expect(createProduct).toHaveBeenCalledOnce();
  expect(createPurchase).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledTimes(2);
});

it("제품 응답을 기다리는 동안 재열면 저장 중 상태를 공유하고 두 번째 생성 요청을 보내지 않는다", async () => {
  let resolve!: (product: Product) => void;
  const createProduct = vi.spyOn(productsApi, "create").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const values = { ...purchaseValues, quantity: "" };
  const first = renderHook(useCreateProduct, { wrapper });
  let saving!: Promise<string>;
  act(() => {
    saving = first.result.current.mutateAsync({ values });
  });
  await waitFor(() => expect(createProduct).toHaveBeenCalledOnce());
  first.unmount();
  const reopened = renderHook(useCreateProduct, { wrapper });
  expect(reopened.result.current.isPending).toBe(true);
  await expect(submit(reopened.result, { values })).rejects.toThrow("저장 중");
  await act(async () => {
    resolve(created);
    await saving;
  });
  expect(reopened.result.current.isPending).toBe(false);
  expect(reopened.result.current.progress?.completedId).toBe(created.id);
  expect(createProduct).toHaveBeenCalledOnce();
  await expect(submit(reopened.result, { values })).rejects.toThrow("이미 등록");
});

it("새로고침으로 라벨 파일을 잃으면 성공한 구매를 보존하고 파일 재선택 후 첨부만 재시도한다", async () => {
  const createProduct = vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const attach = vi
    .spyOn(attachmentsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue({} as never);
  const first = renderHook(useCreateProduct, { wrapper });
  const label = new File(["label"], "label.png", { type: "image/png" });
  await partialFailure(submit(first.result, { values: purchaseValues, labelFile: label }));
  first.unmount();
  // 새 문서는 sessionStorage만 복원하며 메모리의 File은 복원하지 않는다.
  creationLabel(null, false);
  const reopened = renderHook(useCreateProduct, { wrapper });
  await expect(submit(reopened.result, { values: purchaseValues })).rejects.toThrow(
    "라벨 사진을 다시 선택",
  );
  expect(attach).toHaveBeenCalledOnce();
  await submit(reopened.result, { values: purchaseValues, labelFile: label });
  expect(createProduct).toHaveBeenCalledOnce();
  expect(createPurchase).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledTimes(2);
});

it("계정이 바뀌면 이전 생성 응답이 새 계정의 단계와 초안을 지우지 않는다", async () => {
  let resolve!: (product: Product) => void;
  const createProduct = vi.spyOn(productsApi, "create").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = renderHook(useCreateProduct, { wrapper });
  let outcome!: Promise<unknown>;
  act(() => {
    outcome = first.result.current
      .mutateAsync({ values: purchaseValues })
      .catch((error: unknown) => error);
  });
  await waitFor(() => expect(createProduct).toHaveBeenCalledOnce());
  first.unmount();
  await activateDatabase("another-create-owner");
  const key = "sooljang-draft-v1:another-create-owner:creation-test-tab:product:create";
  localStorage.setItem(
    key,
    JSON.stringify({ value: { ...purchaseValues, name: "다음 계정의 술" }, revision: "next" }),
  );
  const next = renderHook(useCreateProduct, { wrapper });
  await act(async () => {
    resolve(created);
    expect(await outcome).toBeInstanceOf(Error);
  });
  expect(next.result.current.progress).toBeNull();
  expect(localStorage.getItem(key)).toContain("다음 계정의 술");
  expect(await db.product.get(created.id)).toBeUndefined();
});

it("동일 계정 재로그인의 새 요청을 이전 요청의 finally가 저장 완료로 표시하지 않는다", async () => {
  const responses: ((product: Product) => void)[] = [];
  const createProduct = vi.spyOn(productsApi, "create").mockImplementation(
    () =>
      new Promise((done) => {
        responses.push(done);
      }),
  );
  const values = { ...purchaseValues, quantity: "" };
  const first = renderHook(useCreateProduct, { wrapper });
  let firstOutcome!: Promise<unknown>;
  act(() => {
    firstOutcome = first.result.current.mutateAsync({ values }).catch((error: unknown) => error);
  });
  await waitFor(() => expect(createProduct).toHaveBeenCalledOnce());
  first.unmount();
  lockDatabase();
  await activateDatabase("online-create-owner");
  const next = renderHook(useCreateProduct, { wrapper });
  let secondOutcome!: Promise<string>;
  act(() => {
    secondOutcome = next.result.current.mutateAsync({ values });
  });
  await waitFor(() => expect(createProduct).toHaveBeenCalledTimes(2));
  await act(async () => {
    responses[0]?.(created);
    await firstOutcome;
  });
  expect(next.result.current.isPending).toBe(true);
  expect(next.result.current.progress?.completedId).toBeNull();
  await act(async () => {
    responses[1]?.(created);
    await secondOutcome;
  });
  await waitFor(() => expect(next.result.current.isPending).toBe(false));
  expect(createProduct.mock.calls[1]?.[0].request_id).toBe(
    createProduct.mock.calls[0]?.[0].request_id,
  );
});

it("등록 완료에 연결한 새 초안은 명시적으로 비운 뒤에만 새로운 등록으로 제출한다", async () => {
  const key = "sooljang-draft-v1:online-create-owner:creation-test-tab:product:create";
  localStorage.setItem(key, JSON.stringify({ value: purchaseValues, revision: "submitted" }));
  let resolve!: (product: Product) => void;
  const createProduct = vi
    .spyOn(productsApi, "create")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ ...created, id: "next-product" });
  vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  const hook = renderHook(useCreateProduct, { wrapper });
  let saving!: Promise<string>;
  act(() => {
    saving = hook.result.current.mutateAsync({ values: purchaseValues });
  });
  await waitFor(() => expect(createProduct).toHaveBeenCalledOnce());
  localStorage.setItem(
    key,
    JSON.stringify({ value: { ...purchaseValues, note: "새 메모" }, revision: "new" }),
  );
  await act(async () => {
    resolve(created);
    await saving;
  });
  act(() => hook.result.current.reset());
  expect(hook.result.current.progress?.completedId).toBe(created.id);
  const captured = captureFormDraft("product:create");
  localStorage.setItem(key, JSON.stringify({ value: purchaseValues, revision: "newer" }));
  expect(hook.result.current.discardCompleted(captured)).toBe(false);
  act(() => {
    expect(hook.result.current.discardCompleted(captureFormDraft("product:create"))).toBe(true);
  });
  expect(localStorage.getItem(key)).toBeNull();
  await submit(hook.result, { values: { ...purchaseValues, name: "의도한 다음 제품" } });
  expect(createProduct).toHaveBeenCalledTimes(2);
  expect(createProduct.mock.calls[1]?.[0].request_id).not.toBe(
    createProduct.mock.calls[0]?.[0].request_id,
  );
});

it("이미 생성한 제품의 남은 입력만 명시적으로 포기하면 서버 제품을 지우지 않고 새 등록을 시작한다", async () => {
  const createProduct = vi.spyOn(productsApi, "create").mockResolvedValue(created);
  vi.spyOn(purchasesApi, "create").mockRejectedValue(new Error("구매 저장 실패"));
  const remove = vi.spyOn(productsApi, "remove");
  const hook = renderHook(useCreateProduct, { wrapper });
  await partialFailure(submit(hook.result, { values: purchaseValues }));
  act(() => {
    expect(hook.result.current.discardCompleted(captureFormDraft("product:create"))).toBe(true);
  });
  expect(hook.result.current.progress).toBeNull();
  expect(await db.product.get(created.id)).toBeDefined();
  expect(remove).not.toHaveBeenCalled();
  await submit(hook.result, { values: { ...purchaseValues, name: "다음 제품", quantity: "" } });
  expect(createProduct).toHaveBeenCalledTimes(2);
  expect(createProduct.mock.calls[1]?.[0].request_id).not.toBe(
    createProduct.mock.calls[0]?.[0].request_id,
  );
});

it("구매 결과가 미확정일 때 병수를 비워도 결과를 확인한 것처럼 등록을 끝내지 않는다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const purchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue({} as never);
  const hook = renderHook(useCreateProduct, { wrapper });
  await partialFailure(submit(hook.result, { values: purchaseValues }));
  await expect(
    submit(hook.result, { values: { ...purchaseValues, quantity: "" } }),
  ).rejects.toThrow("구매 결과가 미확정");
  expect(hook.result.current.progress?.completedId).toBeNull();
  expect(purchase).toHaveBeenCalledOnce();
  await submit(hook.result, { values: purchaseValues });
  expect(purchase.mock.calls[1]?.[0].request_id).toBe(purchase.mock.calls[0]?.[0].request_id);
});

it("라벨 사진이 있는 새 입력은 오프라인에서 사진을 버리고 등록 완료로 처리하지 않는다", async () => {
  connection.state = "offline";
  const hook = renderHook(useCreateProduct, { wrapper });
  await expect(
    submit(hook.result, {
      values: purchaseValues,
      labelFile: new File(["synthetic-file-bytes"], "label.png", { type: "image/png" }),
    }),
  ).rejects.toThrow("온라인에서 저장");
  expect(await db.outbox.count()).toBe(0);
  expect(hook.result.current.progress?.labelPending).toBe(true);
  expect(Object.values(sessionStorage).join()).not.toContain("synthetic-file-bytes");
});
