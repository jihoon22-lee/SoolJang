import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { attachmentsApi, productsApi, purchasesApi, vendorsApi } from "@/api/client";
import type { ProductFilters, User } from "@/api/types";
import { BarcodeScanPanel } from "@/components/BarcodeScanPanel";
import { LabelOcrPanel } from "@/components/LabelOcrPanel";
import { ProductDetail } from "@/components/ProductDetail";
import { ProductFilterPanel } from "@/components/ProductFilterPanel";
import { ProductForm, type ProductFormValues } from "@/components/ProductForm";
import { ProductList } from "@/components/ProductList";
import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { getCategoryTree, getProduct, getProducts, getPurchasesForProduct } from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { newId } from "@/sync/uuid7";

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
  const queryClient = useQueryClient();
  const { state, triggerSync } = useSyncStatus();
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
  // 제품 규모가 수백 건이라 서버처럼 커서 페이지네이션을 하지 않는다 — 전체를 필터·정렬한
  // 뒤 화면에는 `visibleCount` 만큼만 보여준다("더 보기"는 이미 메모리에 있는 걸 더 드러낼
  // 뿐, 다시 조회하지 않는다).
  const allProducts = useLiveQuery(() => getProducts(filters), [filters]);

  const items = allProducts?.slice(0, visibleCount) ?? [];
  const hasMore = (allProducts?.length ?? 0) > visibleCount;

  const createProduct = useMutation({
    mutationFn: async (values: ProductFormValues) => {
      if (!offline) {
        // 기존 온라인 경로. outbox 는 아직 품종(product_variety)을 오프라인 쓰기 대상으로
        // 지원하지 않으므로, 온라인일 때는 이 경로를 그대로 유지해 품종 입력을 지원한다.
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
        if (pendingLabelFile) {
          // 원본 사진 보관("Task 17 원본·결과 보관"). 제품 자체는 이미 만들어졌으니, 이
          // 단계가 실패해도 앞선 단계처럼 오류로 보고한다 — 조용히 건너뛰지 않는다.
          await attachmentsApi.create(pendingLabelFile, { kind: "label", product_id: product.id });
        }
        triggerSync();
        return;
      }

      await createProductOffline(values, queryClient.getQueryData<User>(["auth", "me"])?.id ?? "");
    },
    onSuccess: () => {
      closeForm();
    },
  });

  function closeForm() {
    setFormOpen(false);
    setFormPrefill(null);
    setPendingLabelFile(null);
  }

  if (selectedProductId !== null) {
    return <ProductDetailView productId={selectedProductId} onBack={onDeselectProduct} />;
  }

  return (
    <div className="layout-with-sidebar">
      <ProductFilterPanel
        filters={filters}
        categories={categoryTree?.items ?? []}
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
          <h2 id="products-heading">
            내 술 {(allProducts?.length ?? 0) > 0 && `(${allProducts?.length})`}
          </h2>
          <div className="button-row">
            {/* 스캔·라벨 인식 모두 온라인 전용 외부 호출이 필요하다(카메라+Open Food
            Facts, Vision LLM). */}
            {!offline && <BarcodeScanPanel onSelectProduct={onSelectProduct} />}
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
            onSubmit={(values) => createProduct.mutate(values)}
            onCancel={closeForm}
            initialValues={formPrefill ?? undefined}
          />
        )}

        {allProducts === undefined && <output aria-live="polite">목록을 불러오고 있습니다…</output>}

        {allProducts !== undefined && (
          <>
            <ProductList products={items} onSelect={onSelectProduct} />
            {hasMore && (
              <div className="button-row" style={{ marginTop: 12 }}>
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

function ProductDetailView({ productId, onBack }: { productId: string; onBack: () => void }) {
  const { triggerSync } = useSyncStatus();
  const product = useLiveQuery(() => getProduct(productId), [productId]);
  const purchases = useLiveQuery(() => getPurchasesForProduct(productId), [productId]);

  const remove = useMutation({
    mutationFn: () => enqueue({ entity: "product", op: "delete", entityId: productId, fields: {} }),
    onSuccess: () => {
      triggerSync();
      onBack();
    },
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

  return (
    <ProductDetail
      product={product}
      purchases={purchases ?? []}
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

/**
 * 오프라인 등록 체인: product → sku → (필요하면) vendor → purchase 순으로 outbox 에 쌓는다.
 *
 * 서버는 `purchase.create` 안에서 `bottle_ids` 로 병을 자동 생성한다(`POST /purchases` 의
 * 온라인 동작과 같다) — 그래서 별도 `bottle.create` 오퍼레이션을 보내지 않는다. 로컬 미러에는
 * 낙관적으로 병 행을 직접 써서 병 화면이 바로 재고를 보여주게 한다.
 *
 * 품종(품종·스타일)은 오프라인 쓰기 대상 7종에 들어 있지 않아 여기서는 지정할 수 없다 —
 * 온라인일 때 다시 시도해야 한다.
 */
async function createProductOffline(values: ProductFormValues, userId: string): Promise<void> {
  const now = new Date().toISOString();

  const productId = newId();
  const abv = values.abv || null;
  const vintage = values.vintage ? Number(values.vintage) : null;
  const personalRating = values.personalRating || null;
  const note = values.note || null;
  const categoryId = values.categoryId || null;

  await enqueue({
    entity: "product",
    op: "create",
    entityId: productId,
    fields: {
      name: values.name.trim(),
      category_id: categoryId,
      abv,
      vintage,
      personal_rating: personalRating,
      note,
    },
    optimisticRow: {
      id: productId,
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name: values.name.trim(),
      name_en: null,
      category_id: categoryId,
      producer_id: null,
      country: null,
      region: null,
      abv,
      vintage,
      age_years: null,
      personal_rating: personalRating,
      note,
    },
  });

  let skuId: string | null = null;
  if (values.volumeMl) {
    skuId = newId();
    const volumeMl = Number(values.volumeMl);
    await enqueue({
      entity: "sku",
      op: "create",
      entityId: skuId,
      fields: { product_id: productId, volume_ml: volumeMl },
      optimisticRow: {
        id: skuId,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        product_id: productId,
        volume_ml: volumeMl,
        barcode: null,
        barcode_type: null,
        package_note: null,
      },
    });
  }

  const quantity = Number(values.quantity);
  if (quantity > 0 && skuId) {
    const vendorId = values.vendorName.trim()
      ? await resolveVendorIdOffline(values.vendorName.trim(), userId)
      : null;

    const purchaseId = newId();
    const bottleIds = Array.from({ length: quantity }, () => newId());
    const purchasedOn = values.purchasedOn || null;
    const unitListPrice = values.unitListPrice || null;
    const unitPaidPrice = values.unitPaidPrice || null;

    await enqueue({
      entity: "purchase",
      op: "create",
      entityId: purchaseId,
      fields: {
        sku_id: skuId,
        quantity,
        vendor_id: vendorId,
        purchased_on: purchasedOn,
        unit_list_price: unitListPrice,
        unit_paid_price: unitPaidPrice,
        bottle_ids: bottleIds,
      },
      optimisticRow: {
        id: purchaseId,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        sku_id: skuId,
        vendor_id: vendorId,
        purchased_on: purchasedOn,
        quantity,
        unit_list_price: unitListPrice,
        unit_paid_price: unitPaidPrice,
        currency: "KRW",
        fx_rate: null,
        foreign_unit_price: null,
        discount_note: null,
        import_note: null,
      },
    });

    await db.bottle.bulkPut(
      bottleIds.map((id, index) => ({
        id,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        purchase_id: purchaseId,
        label_no: index + 1,
        status: "unopened",
        opened_on: null,
        finished_on: null,
        remaining_ml: null,
        storage_location: null,
        note: null,
      })),
    );
  }
}

async function resolveVendorIdOffline(name: string, userId: string): Promise<string> {
  const vendors = await db.vendor.toArray();
  const existing = vendors.find((vendor) => vendor.deleted_at === null && vendor.name === name);
  if (existing) return existing.id;

  const id = newId();
  const now = new Date().toISOString();
  await enqueue({
    entity: "vendor",
    op: "create",
    entityId: id,
    fields: { name },
    optimisticRow: {
      id,
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name,
      kind: "other",
      url: null,
      note: null,
    },
  });
  return id;
}
