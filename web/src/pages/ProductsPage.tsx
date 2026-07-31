import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { categoriesApi, productsApi, purchasesApi, vendorsApi } from "@/api/client";
import type { ProductFilters } from "@/api/types";
import { ProductDetail } from "@/components/ProductDetail";
import { ProductFilterPanel } from "@/components/ProductFilterPanel";
import { ProductForm, type ProductFormValues } from "@/components/ProductForm";
import { ProductList } from "@/components/ProductList";

const DEFAULT_FILTERS: ProductFilters = { sort: "name", order: "asc", limit: 30 };

/** 술 목록 화면. 필터·정렬·더 보기와 등록 폼을 담는다. */
export function ProductsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ProductFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => categoriesApi.tree(signal),
  });

  // 커서 페이지네이션. 필터가 바뀌면 queryKey 가 바뀌어 첫 페이지부터 다시 읽는다.
  const products = useInfiniteQuery({
    queryKey: ["products", filters],
    queryFn: ({ pageParam, signal }) => productsApi.list({ ...filters, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });

  const items = useMemo(
    () => products.data?.pages.flatMap((page) => page.items) ?? [],
    [products.data],
  );

  const createProduct = useMutation({
    mutationFn: async (values: ProductFormValues) => {
      const product = await productsApi.create({
        name: values.name.trim(),
        category_id: values.categoryId || null,
        abv: values.abv || null,
        vintage: values.vintage ? Number(values.vintage) : null,
        personal_rating: values.personalRating || null,
        note: values.note || null,
        variety_names: splitVarieties(values.varietyNames),
        skus: values.volumeMl ? [{ volume_ml: Number(values.volumeMl) }] : [],
      });

      const quantity = Number(values.quantity);
      const skuId = product.skus[0]?.id;
      if (quantity > 0 && skuId) {
        const vendorId = values.vendorName.trim()
          ? await resolveVendorId(values.vendorName.trim())
          : null;
        await purchasesApi.create({
          sku_id: skuId,
          quantity,
          vendor_id: vendorId,
          purchased_on: values.purchasedOn || null,
          unit_list_price: values.unitListPrice || null,
          unit_paid_price: values.unitPaidPrice || null,
        });
      }
      return product;
    },
    onSuccess: () => {
      setFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  if (selectedId !== null) {
    return <ProductDetailView productId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="layout-with-sidebar">
      <ProductFilterPanel
        filters={filters}
        categories={categories.data?.items ?? []}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_FILTERS)}
      />

      <section aria-labelledby="products-heading">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h2 id="products-heading">내 술 {items.length > 0 && `(${items.length})`}</h2>
          <button type="button" className="primary" onClick={() => setFormOpen((open) => !open)}>
            {formOpen ? "폼 닫기" : "새 술 등록"}
          </button>
        </div>

        {formOpen && (
          <ProductForm
            categories={categories.data?.items ?? []}
            submitting={createProduct.isPending}
            error={createProduct.error}
            onSubmit={(values) => createProduct.mutate(values)}
            onCancel={() => setFormOpen(false)}
          />
        )}

        {products.isPending && <output aria-live="polite">목록을 불러오고 있습니다…</output>}

        {products.error instanceof Error && (
          <p className="alert" role="alert">
            목록을 불러올 수 없습니다: {products.error.message}
          </p>
        )}

        {!products.isPending && !products.error && (
          <>
            <ProductList products={items} onSelect={setSelectedId} />
            {products.hasNextPage && (
              <div className="button-row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => void products.fetchNextPage()}
                  disabled={products.isFetchingNextPage}
                >
                  {products.isFetchingNextPage ? "불러오는 중…" : "더 보기"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ProductDetailView({ productId, onBack }: { productId: string; onBack: () => void }) {
  const queryClient = useQueryClient();

  const product = useQuery({
    queryKey: ["product", productId],
    queryFn: ({ signal }) => productsApi.get(productId, signal),
  });

  const purchases = useQuery({
    queryKey: ["purchases", productId],
    queryFn: ({ signal }) => purchasesApi.list({ product_id: productId }, signal),
  });

  const remove = useMutation({
    mutationFn: () => productsApi.remove(productId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      onBack();
    },
  });

  if (product.isPending) {
    return <output aria-live="polite">상세 정보를 불러오고 있습니다…</output>;
  }

  if (product.error instanceof Error || !product.data) {
    return (
      <>
        <p className="alert" role="alert">
          제품을 불러올 수 없습니다
          {product.error instanceof Error ? `: ${product.error.message}` : ""}
        </p>
        <button type="button" onClick={onBack}>
          ← 목록으로
        </button>
      </>
    );
  }

  return (
    <ProductDetail
      product={product.data}
      purchases={purchases.data ?? []}
      onBack={onBack}
      onDelete={() => remove.mutate()}
      deleting={remove.isPending}
    />
  );
}

function splitVarieties(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 구매처 이름으로 id 를 찾고, 없으면 만든다. 매번 목록에서 고르게 하면 입력이 느려진다. */
async function resolveVendorId(name: string): Promise<string> {
  const vendors = await vendorsApi.list();
  const existing = vendors.find((vendor) => vendor.name === name);
  if (existing) return existing.id;
  const created = await vendorsApi.create({ name });
  return created.id;
}
