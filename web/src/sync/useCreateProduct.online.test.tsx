import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, attachmentsApi, productsApi, purchasesApi } from "@/api/client";
import type { Product } from "@/api/types";
import { EMPTY_PRODUCT_FORM } from "@/components/ProductForm";
import { activateDatabase, lockDatabase } from "@/sync/db";
import { PartialProductCreationError, useCreateProduct } from "@/sync/useCreateProduct";

vi.mock("@/sync/SyncStatusProvider", () => ({
  useSyncStatus: () => ({ state: "online", triggerSync: vi.fn() }),
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
  sessionStorage.clear();
  await activateDatabase("online-create-owner");
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

  await expect(result.current.mutateAsync({ values, labelFile: null })).rejects.toThrow();
  await result.current.mutateAsync({
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

it("구매 응답을 잃은 뒤 병수를 고쳐 다시 보내도 같은 구매 요청으로 보낸다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  const failed = await partialFailure(
    result.current.mutateAsync({ values: purchaseValues, labelFile: null }),
  );
  await result.current.mutateAsync({
    values: { ...purchaseValues, quantity: "2" },
    labelFile: null,
    existingProduct: failed.product,
    purchaseAlreadyCreated: failed.purchaseCreated,
  });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0].quantity).toBe(2);
  expect(second?.[0].request_id).toBe(first?.[0].request_id);
});

it("구매 뒤 라벨 저장이 실패하면 새로고침 뒤 재시도도 같은 구매 요청으로 돌아온다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi.spyOn(purchasesApi, "create").mockResolvedValue({} as never);
  vi.spyOn(attachmentsApi, "create")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({} as never);
  const label = new File(["label"], "label.png", { type: "image/png" });
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  await partialFailure(result.current.mutateAsync({ values: purchaseValues, labelFile: label }));
  // 새로고침하면 "이미 만든 구매" 표시는 사라지고 저장한 초안만 남는다.
  await result.current.mutateAsync({ values: purchaseValues, labelFile: label });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0].request_id).toBe(first?.[0].request_id);
});

it("검증 오류는 앞선 시도 결과를 알려 주지 않으므로 고쳐 보내도 같은 요청 식별자를 쓴다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new ApiError(422, "입력 오류"))
    .mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  const failed = await partialFailure(
    result.current.mutateAsync({ values: purchaseValues, labelFile: null }),
  );
  await result.current.mutateAsync({
    values: { ...purchaseValues, unitPaidPrice: "48000" },
    labelFile: null,
    existingProduct: failed.product,
  });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0].request_id).toBe(first?.[0].request_id);
});

it("이미 다른 내용으로 저장됐다는 409 뒤에는 새 요청으로 보낸다", async () => {
  vi.spyOn(productsApi, "create").mockResolvedValue(created);
  const createPurchase = vi
    .spyOn(purchasesApi, "create")
    .mockRejectedValueOnce(new ApiError(409, "앞서 보낸 등록이 이미 저장됐습니다"))
    .mockResolvedValue({} as never);
  const { result } = renderHook(() => useCreateProduct(), { wrapper });

  const failed = await partialFailure(
    result.current.mutateAsync({ values: purchaseValues, labelFile: null }),
  );
  await result.current.mutateAsync({
    values: purchaseValues,
    labelFile: null,
    existingProduct: failed.product,
  });

  const [first, second] = createPurchase.mock.calls;
  expect(second?.[0].request_id).not.toBe(first?.[0].request_id);
});
