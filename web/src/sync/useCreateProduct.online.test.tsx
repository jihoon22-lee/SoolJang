import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productsApi, purchasesApi } from "@/api/client";
import type { Product } from "@/api/types";
import { EMPTY_PRODUCT_FORM } from "@/components/ProductForm";
import { activateDatabase, lockDatabase } from "@/sync/db";
import { useCreateProduct } from "@/sync/useCreateProduct";

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
