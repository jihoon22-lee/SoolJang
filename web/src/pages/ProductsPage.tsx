import { useMutation } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { productsApi, purchasesApi } from "@/api/client";
import type { Product, ProductFilters, SortKey } from "@/api/types";
import { BarcodeScanPanel } from "@/components/BarcodeScanPanel";
import { LabelOcrPanel } from "@/components/LabelOcrPanel";
import { type AddPurchaseInput, ProductDetail, type SplitPart } from "@/components/ProductDetail";
import { ProductFilterPanel } from "@/components/ProductFilterPanel";
import { ProductForm, type ProductFormValues } from "@/components/ProductForm";
import { ProductList } from "@/components/ProductList";
import { setLastVendorName } from "@/lastVendor";
import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import {
  getBottlesForProduct,
  getCategoryTree,
  getProduct,
  getProducts,
  getPurchasesForProduct,
  getVendors,
} from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import {
  PartialProductCreationError,
  resolveVendorId,
  splitVarieties,
  useCreateProduct,
} from "@/sync/useCreateProduct";

const DEFAULT_FILTERS: ProductFilters = { sort: "name", order: "asc", limit: 30 };
const PAGE_SIZE = DEFAULT_FILTERS.limit ?? 30;

interface ProductsPageProps {
  /** 상세로 진입한 제품 id. `null` 이면 목록을 보여준다. App 이 URL 해시로 제어한다. */
  selectedProductId: string | null;
  onSelectProduct: (productId: string) => void;
  onDeselectProduct: () => void;
  /** 통계 탭 등 다른 화면에서 주종 필터를 걸고 들어올 때만 준다. 마운트 시점에만
   * `filters.category_id` 를 시딩한다(`ProductForm` 의 `initialValues` 와 같은 패턴) —
   * 이 화면은 탭을 바꿀 때마다 언마운트/리마운트되므로 이후 사용자가 필터를 바꿔도
   * 다시 강제로 되돌리지 않는다. */
  initialCategoryId?: string | undefined;
}

/** 술 목록 화면. 필터·정렬·더 보기와 등록 폼을 담는다. */
export function ProductsPage({
  selectedProductId,
  onSelectProduct,
  onDeselectProduct,
  initialCategoryId,
}: ProductsPageProps) {
  const { state } = useSyncStatus();
  const offline = state === "offline";
  const [filters, setFilters] = useState<ProductFilters>(() =>
    initialCategoryId ? { ...DEFAULT_FILTERS, category_id: initialCategoryId } : DEFAULT_FILTERS,
  );
  const [formOpen, setFormOpen] = useState(false);
  // 라벨 OCR(Task 17)이 채운 값과 원본 사진. 폼이 닫힐 때마다 함께 지운다 — 그러지 않으면
  // 다음에 수동으로 연 폼에 이전 스캔의 흔적이 남는다.
  const [formPrefill, setFormPrefill] = useState<Partial<ProductFormValues> | null>(null);
  const [pendingLabelFile, setPendingLabelFile] = useState<File | null>(null);
  // ProductForm 은 마운트 시점에만 initialValues 를 반영한다 — 폼이 이미 열려 있는 상태로
  // 라벨을 다시 스캔하면(재촬영) 이 값을 바꿔 강제로 다시 마운트시켜야 새 프리필이 반영된다.
  const [formInstance, setFormInstance] = useState(0);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // 필터가 바뀌면 첫 페이지부터 다시 보여준다. 렌더 중 상태를 조정하는 편이(리액트가
  // 권장하는 방식) 이 값을 읽지 않는 useEffect 보다 의도가 분명하다.
  const [countedFilters, setCountedFilters] = useState(filters);
  if (filters !== countedFilters) {
    setCountedFilters(filters);
    setVisibleCount(PAGE_SIZE);
  }

  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const vendors = useLiveQuery(() => getVendors(), []);
  const vendorNames = (vendors ?? []).map((vendor) => vendor.name);
  // 제품 규모가 수백 건이라 서버처럼 커서 페이지네이션을 하지 않는다 — 전체를 필터·정렬한
  // 뒤 화면에는 `visibleCount` 만큼만 보여준다("더 보기"는 이미 메모리에 있는 걸 더 드러낼
  // 뿐, 다시 조회하지 않는다).
  const allProducts = useLiveQuery(() => getProducts(filters), [filters]);
  // 이름 자동완성·중복 등록 경고는 현재 필터와 무관하게 전체 카탈로그를 대상으로 해야 한다
  // (필터가 걸려 있어도 "이미 등록된 술"을 놓치면 안 된다).
  const allProductsUnfiltered = useLiveQuery(() => getProducts({}), []);

  const items = allProducts?.slice(0, visibleCount) ?? [];
  const hasMore = (allProducts?.length ?? 0) > visibleCount;

  // 상세로 들어가기 직전 스크롤 위치를 기억해 뒤로 왔을 때 되돌린다. `visibleCount`
  // ("더 보기" 로 펼친 개수)는 이 컴포넌트가 상세 진입/복귀 사이에 언마운트되지 않아
  // 별도 처리 없이도 이미 유지된다 — 스크롤 위치만 브라우저가 기억해 주지 않는다.
  const savedScrollY = useRef<number | null>(null);
  useEffect(() => {
    // `null` 이면 아직 상세로 들어간 적이 없다는 뜻이다(최초 마운트 포함) — 되돌릴 위치가
    // 없으니 그냥 둔다.
    if (selectedProductId === null && savedScrollY.current !== null) {
      window.scrollTo(0, savedScrollY.current);
      savedScrollY.current = null;
    }
  }, [selectedProductId]);

  function selectProduct(productId: string): void {
    savedScrollY.current = window.scrollY;
    onSelectProduct(productId);
  }

  // 키보드 단축키: "/" 로 이름 검색 포커스, Esc 로 등록 폼 닫기. 이미 입력 중일 때는
  // "/" 를 문자로 그대로 칠 수 있어야 하므로 가로채지 않는다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const isTyping = target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        document.getElementById("filter-q")?.focus();
      } else if (event.key === "Escape" && formOpen) {
        closeForm();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const createProduct = useCreateProduct();

  function closeForm() {
    setFormOpen(false);
    setFormPrefill(null);
    setPendingLabelFile(null);
    // 실패 후 남은 `PartialProductCreationError` 를 지운다 — 안 지우면 폼을 취소하고
    // 전혀 다른 제품을 새로 등록할 때도 이전 시도의 제품을 재사용하려 든다(B7).
    createProduct.reset();
  }

  /** 표 헤더 클릭 정렬. `ProductFilterPanel` 의 정렬 드롭다운과 같은 상태를 토글할 뿐,
   * 별도 정렬 로직을 두지 않는다. 같은 열을 다시 누르면 방향만 뒤집는다. */
  function handleSort(key: SortKey) {
    setFilters((prev) => ({
      ...prev,
      sort: key,
      order: prev.sort === key && prev.order === "asc" ? "desc" : "asc",
    }));
  }

  if (selectedProductId !== null) {
    return (
      <ProductDetailView
        productId={selectedProductId}
        onBack={onDeselectProduct}
        vendorNames={vendorNames}
      />
    );
  }

  return (
    <div className="layout-with-sidebar">
      <ProductFilterPanel
        filters={filters}
        categories={categoryTree?.items ?? []}
        vendors={vendors ?? []}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_FILTERS)}
      />

      <section aria-labelledby="products-heading">
        <div className="section-header">
          <h2 id="products-heading">
            내 술 {(allProducts?.length ?? 0) > 0 && `(${allProducts?.length})`}
          </h2>
          <div className="button-row">
            {/* 스캔·라벨 인식 모두 온라인 전용 외부 호출이 필요하다(카메라+Open Food
            Facts, Vision LLM). */}
            {!offline && <BarcodeScanPanel onSelectProduct={selectProduct} />}
            {!offline && (
              <LabelOcrPanel
                categories={categoryTree?.items ?? []}
                onPrefill={(values, file) => {
                  setFormPrefill(values);
                  setPendingLabelFile(file);
                  setFormInstance((instance) => instance + 1);
                  setFormOpen(true);
                }}
              />
            )}
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (formOpen) {
                  closeForm();
                } else {
                  setFormPrefill(null);
                  setPendingLabelFile(null);
                  setFormOpen(true);
                }
              }}
            >
              {formOpen ? "폼 닫기" : "새 술 등록"}
            </button>
          </div>
        </div>

        {formOpen && (
          <ProductForm
            key={formInstance}
            categories={categoryTree?.items ?? []}
            submitting={createProduct.isPending}
            error={createProduct.error}
            onSubmit={(values) => {
              // 직전 시도가 "제품은 만들어졌는데 나머지가 실패" 였다면(B7), 그 제품과
              // 진행 상태를 그대로 넘겨 재시도가 중복 생성을 하지 않게 한다.
              const priorError = createProduct.error;
              const retry =
                priorError instanceof PartialProductCreationError
                  ? {
                      existingProduct: priorError.product,
                      purchaseAlreadyCreated: priorError.purchaseCreated,
                    }
                  : {};
              createProduct.mutate(
                { values, labelFile: pendingLabelFile, ...retry },
                { onSuccess: closeForm },
              );
            }}
            onCancel={closeForm}
            initialValues={formPrefill ?? undefined}
            existingProducts={allProductsUnfiltered ?? []}
            vendorNames={vendorNames}
            onSelectExisting={(id) => {
              closeForm();
              onSelectProduct(id);
            }}
          />
        )}

        {allProducts === undefined && <output aria-live="polite">목록을 불러오고 있습니다…</output>}

        {allProducts !== undefined && (
          <>
            <ProductList
              products={items}
              onSelect={selectProduct}
              sort={filters.sort ?? "name"}
              order={filters.order ?? "asc"}
              onSort={handleSort}
            />
            {hasMore && (
              <div className="button-row mt-3">
                <button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                  더 보기
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** 제품 값을 `ProductForm` 의 edit 모드 프리필 형식으로 바꾼다. */
function valuesFromProduct(product: Product): Partial<ProductFormValues> {
  return {
    name: product.name,
    categoryId: product.category_id ?? "",
    abv: product.abv ?? "",
    vintage: product.vintage !== null ? String(product.vintage) : "",
    personalRating: product.personal_rating ?? "",
    varietyNames: product.varieties.join(", "),
    note: product.note ?? "",
  };
}

function ProductDetailView({
  productId,
  onBack,
  vendorNames,
}: {
  productId: string;
  onBack: () => void;
  vendorNames: string[];
}) {
  const { state, triggerSync } = useSyncStatus();
  const offline = state === "offline";
  const product = useLiveQuery(() => getProduct(productId), [productId]);
  const purchases = useLiveQuery(() => getPurchasesForProduct(productId), [productId]);
  const bottles = useLiveQuery(() => getBottlesForProduct(productId), [productId]);
  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const [editing, setEditing] = useState(false);

  const remove = useMutation({
    mutationFn: () => enqueue({ entity: "product", op: "delete", entityId: productId, fields: {} }),
    onSuccess: () => {
      triggerSync();
      onBack();
    },
  });

  const updateProduct = useMutation({
    mutationFn: async (values: ProductFormValues) => {
      const fields = {
        name: values.name.trim(),
        category_id: values.categoryId || null,
        abv: values.abv || null,
        vintage: values.vintage ? Number(values.vintage) : null,
        personal_rating: values.personalRating || null,
        note: values.note || null,
      };

      if (!offline) {
        // variety_names 는 오프라인 제네릭 디스패치가 지원하지 않는다 — 온라인 전용으로 보낸다.
        await productsApi.update(productId, {
          ...fields,
          variety_names: splitVarieties(values.varietyNames),
        });
        triggerSync();
        return;
      }

      const current = await db.product.get(productId);
      if (!current) throw new Error("제품을 찾을 수 없습니다");
      await enqueue({
        entity: "product",
        op: "update",
        entityId: productId,
        baseUpdatedAt: current.updated_at as string,
        fields,
        optimisticRow: { ...current, ...fields, updated_at: new Date().toISOString() },
      });
    },
    onSuccess: () => setEditing(false),
  });

  // 구매 추가·삭제·분할·규격 추가는 서버 상태 기준으로 병 라벨을 재배치하므로 온라인
  // 전용이다(ProductDetail 이 오프라인이면 버튼 자체를 숨긴다 — 여기 mutationFn 은 항상
  // 온라인 호출을 가정한다).
  const addPurchase = useMutation({
    mutationFn: async (input: AddPurchaseInput) => {
      const vendorId = input.vendorName ? await resolveVendorId(input.vendorName) : null;
      await purchasesApi.create({
        sku_id: input.skuId,
        quantity: input.quantity,
        vendor_id: vendorId,
        purchased_on: input.purchasedOn || null,
        unit_list_price: input.unitListPrice || null,
        unit_paid_price: input.unitPaidPrice || null,
      });
    },
    onSuccess: (_result, input) => {
      if (input.vendorName) setLastVendorName(input.vendorName);
      triggerSync();
    },
  });

  const deletePurchase = useMutation({
    mutationFn: (purchaseId: string) => purchasesApi.remove(purchaseId),
    onSuccess: () => triggerSync(),
  });

  const splitPurchase = useMutation({
    mutationFn: async ({ purchaseId, parts }: { purchaseId: string; parts: SplitPart[] }) => {
      const resolvedParts = await Promise.all(
        parts.map(async (part) => {
          const vendorName = part.vendorName.trim();
          return {
            quantity: Number(part.quantity),
            vendor_id: vendorName ? await resolveVendorId(vendorName) : null,
          };
        }),
      );
      await purchasesApi.split(purchaseId, resolvedParts);
    },
    onSuccess: () => triggerSync(),
  });

  const addSku = useMutation({
    mutationFn: (volumeMl: number) => productsApi.addSku(productId, volumeMl),
    onSuccess: () => triggerSync(),
  });

  if (product === undefined) {
    return <output aria-live="polite">상세 정보를 불러오고 있습니다…</output>;
  }

  if (product === null) {
    return (
      <>
        <p className="alert" role="alert">
          제품을 불러올 수 없습니다
        </p>
        <button type="button" onClick={onBack}>
          ← 목록으로
        </button>
      </>
    );
  }

  if (editing) {
    return (
      <ProductForm
        mode="edit"
        categories={categoryTree?.items ?? []}
        submitting={updateProduct.isPending}
        error={updateProduct.error}
        onSubmit={(values) => updateProduct.mutate(values)}
        onCancel={() => setEditing(false)}
        initialValues={valuesFromProduct(product)}
      />
    );
  }

  return (
    <ProductDetail
      product={product}
      purchases={purchases ?? []}
      bottles={bottles ?? []}
      offline={offline}
      onBack={onBack}
      onEdit={() => setEditing(true)}
      onDelete={() => remove.mutate()}
      deleting={remove.isPending}
      onAddPurchase={(input) => addPurchase.mutate(input)}
      addingPurchase={addPurchase.isPending}
      addPurchaseError={addPurchase.error}
      vendorNames={vendorNames}
      onDeletePurchase={(purchaseId) => deletePurchase.mutate(purchaseId)}
      deletingPurchaseId={deletePurchase.isPending ? (deletePurchase.variables ?? null) : null}
      onSplitPurchase={(purchaseId, parts) => splitPurchase.mutate({ purchaseId, parts })}
      splittingPurchaseId={
        splitPurchase.isPending ? (splitPurchase.variables?.purchaseId ?? null) : null
      }
      splitError={splitPurchase.error}
      onAddSku={(volumeMl) => addSku.mutate(volumeMl)}
      addingSku={addSku.isPending}
    />
  );
}
