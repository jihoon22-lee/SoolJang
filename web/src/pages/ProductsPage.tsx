import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, productsApi, purchasesApi } from "@/api/client";
import type { Product, ProductFilters, PurchaseScope, SortKey } from "@/api/types";
import { BarcodeScanPanel } from "@/components/BarcodeScanPanel";
import { LabelOcrPanel } from "@/components/LabelOcrPanel";
import { type AddPurchaseInput, ProductDetail, type SplitPart } from "@/components/ProductDetail";
import { ProductFilterPanel } from "@/components/ProductFilterPanel";
import { ProductForm, type ProductFormValues } from "@/components/ProductForm";
import { ProductList } from "@/components/ProductList";
import type { EditPurchaseInput } from "@/components/PurchaseEditForm";
import { LoadingState } from "@/components/StatusViews";
import { useToast } from "@/components/Toast";
import { downloadCsv, productCsvData } from "@/csvExport";
import { todayLocal } from "@/format";
import { setLastVendorName } from "@/lastVendor";
import { readProductListState, saveProductListState } from "@/productListState";
import { hasPurchaseScope, purchaseScopeLabel, selectPurchaseScope } from "@/purchaseScope";
import type { ProductContext } from "@/router";
import { getStockFirstPreference, setStockFirstPreference } from "@/stockFirstPreference";
import { databaseIdentity, db } from "@/sync/db";
import { clearFormDraft } from "@/sync/drafts";
import { enqueue } from "@/sync/outbox";
import { resolveProductContext } from "@/sync/productContext";
import { enqueueProductDelete } from "@/sync/productDelete";
import {
  filterAndSortProducts,
  getBottlesForProduct,
  getCategoryTree,
  getProduct,
  getProductCatalog,
  getPurchasesForProduct,
  getVendors,
} from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import {
  PartialProductCreationError,
  resolveProducerIdOffline,
  resolveVendorId,
  splitVarieties,
  useCreateProduct,
} from "@/sync/useCreateProduct";
import { useSessionMutation } from "@/sync/useSessionMutation";
import { captureWriteSession } from "@/sync/writeSession";

const DEFAULT_FILTERS: ProductFilters = { sort: "name", order: "asc", limit: 30 };
const PAGE_SIZE = DEFAULT_FILTERS.limit ?? 30;
const listScroller = () =>
  document.querySelector<HTMLElement>(".product-list-results .table-scroll");

interface ProductsPageProps {
  /** 상세로 진입한 제품 id. `null` 이면 목록을 보여준다. App 이 URL 해시로 제어한다. */
  selectedProductId: string | null;
  context?: ProductContext;
  onSelectProduct: (productId: string, context?: ProductContext) => void;
  onDeselectProduct: () => void;
  /** 통계 탭 등 다른 화면에서 주종 필터를 걸고 들어올 때만 준다. 마운트 시점에만
   * `filters.category_id` 를 시딩한다(`ProductForm` 의 `initialValues` 와 같은 패턴) —
   * 이 화면은 탭을 바꿀 때마다 언마운트/리마운트되므로 이후 사용자가 필터를 바꿔도
   * 다시 강제로 되돌리지 않는다. */
  initialCategoryId?: string | undefined;
  /** 구매처 화면에서 "이 구매처에서 산 술" 로 드릴다운할 때만 준다. `initialCategoryId` 와
   * 같은 마운트 시점 시딩 패턴이다. */
  initialVendorId?: string | undefined;
  /** 매장 모드로 이동한다. 모바일 폭에서만 보이는 진입 버튼에 연결한다(항목 6). */
  onOpenStoreMode: () => void;
}

/** 술 목록 화면. 필터·정렬·더 보기와 등록 폼을 담는다. */
/** 제품 주종 변경을 outbox 에 적재한다(낙관적 반영 포함). 일괄 편집·실행 취소가 함께 쓴다. */
async function enqueueCategoryChange(productId: string, categoryId: string | null): Promise<void> {
  const current = await db.product.get(productId);
  if (!current || current.deleted_at !== null) return;
  if ((current.category_id ?? null) === categoryId) return;
  await enqueue({
    entity: "product",
    op: "update",
    entityId: productId,
    baseUpdatedAt: current.updated_at as string,
    fields: { category_id: categoryId },
    optimisticRow: { ...current, category_id: categoryId, updated_at: new Date().toISOString() },
  });
}

export function ProductsPage({
  selectedProductId,
  context = {},
  onSelectProduct,
  onDeselectProduct,
  initialCategoryId,
  initialVendorId,
  onOpenStoreMode,
}: ProductsPageProps) {
  const toast = useToast();
  const { state } = useSyncStatus();
  const offline = state === "offline";
  const owner = databaseIdentity().userId ?? "";
  const [restoredList] = useState(() =>
    initialCategoryId || initialVendorId ? null : readProductListState(owner),
  );
  const [filters, setFilters] = useState<ProductFilters>(() => {
    if (initialCategoryId) return { ...DEFAULT_FILTERS, category_id: initialCategoryId };
    if (initialVendorId) return { ...DEFAULT_FILTERS, vendor_id: initialVendorId };
    return restoredList?.filters ?? DEFAULT_FILTERS;
  });
  // 재고 우선 정렬 켬/끔. 기기별 표시 설정이라 `filters`(서버 쿼리 계약)와 분리해 두고
  // `localStorage` 에 기억한다(`stockFirstPreference.ts`, `lastVendor.ts` 와 같은 패턴).
  const [stockFirst, setStockFirst] = useState(() => getStockFirstPreference());
  function updateStockFirst(next: boolean) {
    setStockFirst(next);
    setStockFirstPreference(next);
  }
  const [formOpen, setFormOpen] = useState(false);
  // 모바일 폭에서 기본 접힘인 필터 패널의 펼침 상태(항목 2). `ProductFilterPanel` 이 아니라
  // 여기서 쥐는 이유는 "/" 단축키가 접힌 상태에서도 검색창으로 포커스를 옮길 수 있어야 하기
  // 때문이다(아래 keydown 핸들러 참고).
  const [filterExpanded, setFilterExpanded] = useState(false);
  // "/" 를 눌렀을 때 패널이 이미 접혀 있었다면, 펼침이 반영돼 입력이 실제로 렌더링된
  // 뒤에야 포커스를 옮길 수 있다(state 갱신은 비동기라 같은 이벤트 안에서 바로 옮기면
  // 아직 `display:none` 인 요소를 포커스하게 된다) — 이 ref 로 "펼쳐지면 포커스" 를 예약한다.
  const pendingFilterFocusRef = useRef(false);
  useEffect(() => {
    if (filterExpanded && pendingFilterFocusRef.current) {
      pendingFilterFocusRef.current = false;
      document.getElementById("filter-q")?.focus();
    }
  }, [filterExpanded]);
  // 라벨 OCR(Task 17)이 채운 값과 원본 사진. 폼이 닫힐 때마다 함께 지운다 — 그러지 않으면
  // 다음에 수동으로 연 폼에 이전 스캔의 흔적이 남는다.
  const [formPrefill, setFormPrefill] = useState<Partial<ProductFormValues> | null>(null);
  const [pendingLabelFile, setPendingLabelFile] = useState<File | null>(null);
  // ProductForm 은 마운트 시점에만 initialValues 를 반영한다 — 폼이 이미 열려 있는 상태로
  // 라벨을 다시 스캔하면(재촬영) 이 값을 바꿔 강제로 다시 마운트시켜야 새 프리필이 반영된다.
  const [formInstance, setFormInstance] = useState(0);
  const [visibleCount, setVisibleCount] = useState(restoredList?.visibleCount ?? PAGE_SIZE);
  // 대량 편집(여러 제품 주종 일괄 변경) 상태. 온라인 전용이다(선택한 제품들에 PATCH 반복).
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  // 필터가 바뀌면 첫 페이지부터 다시 보여준다. 렌더 중 상태를 조정하는 편이(리액트가
  // 권장하는 방식) 이 값을 읽지 않는 useEffect 보다 의도가 분명하다.
  const [countedFilters, setCountedFilters] = useState(filters);
  if (filters !== countedFilters) {
    setCountedFilters(filters);
    setVisibleCount(PAGE_SIZE);
  }

  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const vendors = useLiveQuery(() => getVendors(), []);
  const vendorNames = useMemo(() => (vendors ?? []).map((vendor) => vendor.name), [vendors]);
  // 카탈로그(조인 + 지표 계산, 제품 규모에 비례하는 유일하게 비싼 부분)는 한 번만 조회하고,
  // 필터 있는/없는 두 가지 뷰(목록에 보여줄 것 vs 자동완성·중복 등록 경고가 볼 전체)는
  // 순수 함수로 그 결과에서 파생시킨다 — 예전엔 이 둘이 각각 독립적으로 조회해 카탈로그
  // 조립을 두 번 했다.
  const catalog = useLiveQuery(() => getProductCatalog(), []);
  // 제품 규모가 수백 건이라 서버처럼 커서 페이지네이션을 하지 않는다 — 전체를 필터·정렬한
  // 뒤 화면에는 `visibleCount` 만큼만 보여준다("더 보기"는 이미 메모리에 있는 걸 더 드러낼
  // 뿐, 다시 조회하지 않는다).
  const allProducts = useMemo(
    () =>
      catalog && categoryTree
        ? filterAndSortProducts(catalog, categoryTree, filters, { stockFirst })
        : undefined,
    [catalog, categoryTree, filters, stockFirst],
  );
  // 이름 자동완성·중복 등록 경고는 현재 필터와 무관하게 전체 카탈로그를 대상으로 해야 한다
  // (필터가 걸려 있어도 "이미 등록된 술"을 놓치면 안 된다).
  const allProductsUnfiltered = catalog?.products;

  const matchingPurchaseIds = useMemo(() => {
    if (!catalog || !context.purchaseScope || !selectedProductId) return undefined;
    const product = catalog.products.find((item) => item.id === selectedProductId);
    return product
      ? selectPurchaseScope(
          product,
          catalog.purchasesByProduct.get(product.id) ?? [],
          context.purchaseScope,
        ).purchaseIds
      : [];
  }, [catalog, context.purchaseScope, selectedProductId]);
  const items = allProducts?.slice(0, visibleCount) ?? [];
  const activeFilters = describeActiveFilters(filters, categoryTree?.items ?? [], vendors ?? []);
  const hasMore = (allProducts?.length ?? 0) > visibleCount;

  // 상세로 들어가기 직전 스크롤 위치를 기억해 뒤로 왔을 때 되돌린다. `visibleCount`
  // ("더 보기" 로 펼친 개수)는 이 컴포넌트가 상세 진입/복귀 사이에 언마운트되지 않아
  // 별도 처리 없이도 이미 유지된다 — 스크롤 위치만 브라우저가 기억해 주지 않는다.
  const savedScrollY = useRef<number | null>(restoredList?.scrollY ?? null);
  const savedTableScroll = useRef(restoredList?.tableScrollTop ?? 0);
  useEffect(() => {
    // `null` 이면 아직 상세로 들어간 적이 없다는 뜻이다(최초 마운트 포함) — 되돌릴 위치가
    // 없으니 그냥 둔다.
    if (selectedProductId === null && allProducts !== undefined && savedScrollY.current !== null) {
      window.scrollTo(0, savedScrollY.current);
      const scroller = listScroller();
      if (scroller) scroller.scrollTop = savedTableScroll.current;
      savedScrollY.current = null;
    }
  }, [selectedProductId, allProducts]);

  useEffect(() => {
    if (selectedProductId !== null || allProducts === undefined) return;
    const remember = () =>
      saveProductListState(owner, {
        filters,
        visibleCount,
        scrollY: window.scrollY,
        tableScrollTop: listScroller()?.scrollTop ?? 0,
      });
    remember();
    document.addEventListener("scroll", remember, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", remember, true);
  }, [owner, filters, visibleCount, selectedProductId, allProducts]);

  function selectProduct(productId: string, target?: ProductContext, keepScope = true): void {
    savedScrollY.current = window.scrollY;
    savedTableScroll.current = listScroller()?.scrollTop ?? 0;
    saveProductListState(owner, {
      filters,
      visibleCount,
      scrollY: window.scrollY,
      tableScrollTop: savedTableScroll.current,
    });
    const scope: PurchaseScope = {
      volume_ml: filters.volume_ml,
      vendor_id: filters.vendor_id,
      purchased_on_min: filters.purchased_on_min,
      purchased_on_max: filters.purchased_on_max,
      in_stock: filters.in_stock,
    };
    onSelectProduct(productId, {
      ...target,
      purchaseScope: keepScope && hasPurchaseScope(scope) ? scope : undefined,
    });
  }

  // 키보드 단축키: "/" 로 이름 검색 포커스, Esc 로 등록 폼 닫기. 이미 입력 중일 때는
  // "/" 를 문자로 그대로 칠 수 있어야 하므로 가로채지 않는다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const isTyping = target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        // 모바일 폭에서는 필터 패널이 기본 접힘(항목 2)이라 그 안의 검색창은 펼치기 전엔
        // 화면에 없다 — 단축키가 접힌 상태에서 무력화되지 않게 먼저 강제로 펼친다.
        if (filterExpanded) {
          document.getElementById("filter-q")?.focus();
        } else {
          pendingFilterFocusRef.current = true;
          setFilterExpanded(true);
        }
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

  function toggleSelect(productId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  function exitSelection() {
    setSelecting(false);
    setSelectedIds(new Set());
    setBulkCategoryId("");
  }

  function toggleAll(ids: string[], checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // 선택은 현재 필터 결과 안에서만 유효하다. 필터를 바꿔 목록에서 사라진 제품이 보이지 않는
  // 채로 함께 바뀌던 결함을 막는다(선택 상태 자체는 필터를 되돌리면 다시 살아난다).
  const filteredIds = useMemo(
    () => new Set((allProducts ?? []).map((product) => product.id)),
    [allProducts],
  );
  const liveSelected = useMemo(
    () => new Set([...selectedIds].filter((id) => filteredIds.has(id))),
    [selectedIds, filteredIds],
  );
  const hiddenSelected = selectedIds.size - liveSelected.size;

  // 일괄 편집은 제품마다 outbox 명령 하나다. 오프라인에서도 되고, 실패한 항목은 동기화 배지에
  // 개별로 남아 수정·재시도할 수 있다. 끝나면 "실행 취소"로 원래 주종을 되돌린다.
  const bulkChange = useSessionMutation({
    mutationFn: async (input: { ids: string[]; categoryId: string | null }, session) => {
      const previous: { id: string; categoryId: string | null }[] = [];
      for (const id of input.ids) {
        session.assertCurrent();
        const current = await db.product.get(id);
        if (!current || current.deleted_at !== null) continue;
        previous.push({ id, categoryId: (current.category_id as string | null) ?? null });
        session.assertCurrent();
        await enqueueCategoryChange(id, input.categoryId);
      }
      return previous;
    },
    onSuccess: (previous, input) => {
      const name =
        input.categoryId === null
          ? "주종 미지정"
          : (categoryTree?.items.find((node) => node.id === input.categoryId)?.path.join(" > ") ??
            "선택한 주종");
      toast.show({
        message: `${previous.length}건을 ${name}(으)로 옮겼습니다`,
        actionLabel: "실행 취소",
        onAction: async () => {
          for (const item of previous) await enqueueCategoryChange(item.id, item.categoryId);
          toast.show({ message: "주종을 되돌렸습니다" });
        },
      });
      exitSelection();
    },
  });

  const bulkDelete = useSessionMutation({
    mutationFn: async (ids: string[], session) => {
      for (const id of ids) {
        session.assertCurrent();
        await enqueueProductDelete(id);
      }
      return ids.length;
    },
    onSuccess: (count) => {
      toast.show({ message: `${count}건을 삭제했습니다` });
      exitSelection();
    },
  });

  function confirmBulkDelete(): void {
    const ids = [...liveSelected];
    const chosen = (allProducts ?? []).filter((product) => liveSelected.has(product.id));
    const bottleCount = chosen.reduce((sum, product) => sum + product.metrics.purchased_count, 0);
    if (
      window.confirm(
        `선택한 술 ${ids.length}건과 그 구매·병 ${bottleCount}병 기록을 삭제할까요? 시음 기록은 남습니다.`,
      )
    )
      bulkDelete.mutate(ids);
  }

  if (selectedProductId !== null) {
    if (context.purchaseScope && !catalog)
      return <LoadingState label="선택한 구매 조건을 불러오고 있습니다…" />;
    return (
      <ProductDetailView
        key={selectedProductId}
        productId={selectedProductId}
        context={context}
        matchingPurchaseIds={matchingPurchaseIds}
        onSelectContext={(next) =>
          onSelectProduct(selectedProductId, {
            ...next,
            purchaseScope: "purchaseScope" in next ? next.purchaseScope : context.purchaseScope,
          })
        }
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
        expanded={filterExpanded}
        onExpandedChange={setFilterExpanded}
        stockFirst={stockFirst}
        onStockFirstChange={updateStockFirst}
      />

      <section aria-labelledby="products-heading" className="product-list-results">
        <div className="section-header">
          <h2 id="products-heading" className="page-title">
            내 술 {(allProducts?.length ?? 0) > 0 && `(${allProducts?.length})`}
          </h2>
          <div className="button-row products-toolbar">
            {/* 스캔·라벨 인식 모두 온라인 전용 외부 호출이 필요하다(카메라+Open Food
            Facts, Vision LLM). */}
            {!offline && (
              <BarcodeScanPanel
                onSelectProduct={(id, target) => selectProduct(id, target, false)}
              />
            )}
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
            <button
              type="button"
              aria-pressed={selecting}
              onClick={() => {
                if (selecting) exitSelection();
                else setSelecting(true);
              }}
            >
              {selecting ? "선택 끝내기" : "여러 개 선택"}
            </button>
            <button
              type="button"
              disabled={!allProducts || allProducts.length === 0}
              onClick={() => allProducts && exportProducts(allProducts)}
            >
              CSV 내보내기
            </button>
            {/* 매장에서 술을 앞에 두고 쓰는 모바일 흐름이라 좁은 화면에서만 보인다(항목 6). */}
            <button type="button" className="store-mode-entry" onClick={onOpenStoreMode}>
              매장 모드
            </button>
          </div>
        </div>

        {selecting && (
          <div className="selection-toolbar">
            <span>
              {liveSelected.size}건 선택됨
              {hiddenSelected > 0 ? ` · 필터 밖 ${hiddenSelected}건은 제외` : ""}
            </span>
            <button
              type="button"
              className="sort-button"
              onClick={() => toggleAll([...filteredIds], true)}
            >
              필터 결과 {filteredIds.size}건 모두 선택
            </button>
            <button type="button" className="sort-button" onClick={() => setSelectedIds(new Set())}>
              선택 해제
            </button>
          </div>
        )}

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
            onSelectExisting={(id, target) => {
              closeForm();
              onSelectProduct(id, target);
            }}
          />
        )}

        {allProducts === undefined && <LoadingState label="목록을 불러오고 있습니다…" />}

        {allProducts !== undefined && (
          <>
            {allProducts.length === 0 && activeFilters.length > 0 ? (
              <div className="filter-chips">
                <span className="muted text-sm">조건:</span>
                {activeFilters.map((label) => (
                  <span key={label} className="chip">
                    {label}
                  </span>
                ))}
                <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)}>
                  조건 모두 해제
                </button>
              </div>
            ) : null}
            <ProductList
              products={items}
              priceScopeLabel={purchaseScopeLabel(filters)}
              onSelect={selectProduct}
              sort={filters.sort ?? "name"}
              order={filters.order ?? "asc"}
              onSort={handleSort}
              selectable={selecting}
              selectedIds={liveSelected}
              onToggleSelect={toggleSelect}
              onToggleAll={toggleAll}
            />
            {selecting && liveSelected.size > 0 && (
              <div className="bulk-bar" role="toolbar" aria-label="선택한 술 처리">
                <span className="bulk-bar-count">{liveSelected.size}건</span>
                <label htmlFor="bulk-category" className="sr-only">
                  옮길 주종
                </label>
                <select
                  id="bulk-category"
                  value={bulkCategoryId}
                  onChange={(event) => setBulkCategoryId(event.target.value)}
                >
                  <option value="">주종 선택</option>
                  <option value="__none__">주종 미지정으로</option>
                  {(categoryTree?.items ?? []).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.path.join(" > ")}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="primary"
                  disabled={!bulkCategoryId || bulkChange.isPending}
                  onClick={() =>
                    bulkChange.mutate({
                      ids: [...liveSelected],
                      categoryId: bulkCategoryId === "__none__" ? null : bulkCategoryId,
                    })
                  }
                >
                  {bulkChange.isPending ? "옮기는 중…" : "주종 변경"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={bulkDelete.isPending}
                  onClick={confirmBulkDelete}
                >
                  삭제
                </button>
              </div>
            )}
            {hasMore && (
              <LoadMoreSentinel onVisible={() => setVisibleCount((count) => count + PAGE_SIZE)} />
            )}
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
    producerName: product.producer_name ?? "",
    abv: product.abv ?? "",
    vintage: product.vintage !== null ? String(product.vintage) : "",
    ageYears: product.age_years !== null ? product.age_years : "",
    personalRating: product.personal_rating ?? "",
    varietyNames: product.varieties.join(", "),
    note: product.note ?? "",
  };
}

function ProductDetailView({
  productId,
  context,
  matchingPurchaseIds,
  onSelectContext,
  onBack,
  vendorNames,
}: {
  productId: string;
  context: ProductContext;
  matchingPurchaseIds?: readonly string[] | undefined;
  onSelectContext: (context: ProductContext) => void;
  onBack: () => void;
  vendorNames: string[];
}) {
  const toast = useToast();
  const { state, triggerSync } = useSyncStatus();
  const offline = state === "offline";
  const target = useLiveQuery(
    () => resolveProductContext(productId, context),
    [productId, context.skuId, context.bottleId, context.tastingId],
  );
  const product = useLiveQuery(() => getProduct(productId), [productId]);
  const purchases = useLiveQuery(() => getPurchasesForProduct(productId), [productId]);
  const bottles = useLiveQuery(() => getBottlesForProduct(productId), [productId]);
  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const [editing, setEditing] = useState(false);
  const contextSignature = JSON.stringify(context);
  const [pendingPurchaseTarget, setPendingPurchaseTarget] = useState<{
    skuId: string;
    contextSignature: string;
  } | null>(null);

  const remove = useSessionMutation({
    mutationFn: () => enqueueProductDelete(productId),
    onSuccess: () => {
      triggerSync();
      onBack();
    },
  });

  const updateProduct = useSessionMutation({
    mutationFn: async (values: ProductFormValues, session) => {
      const producerName = values.producerName?.trim() || null;
      const fields = {
        name: values.name.trim(),
        category_id: values.categoryId || null,
        abv: values.abv || null,
        vintage: values.vintage ? Number(values.vintage) : null,
        age_years: values.ageYears || null,
        personal_rating: values.personalRating || null,
        note: values.note || null,
      };

      if (!offline) {
        // variety_names 는 오프라인 제네릭 디스패치가 지원하지 않는다 — 온라인 전용으로 보낸다.
        // producer_name 은 서버가 id 로 해석한다(자동 생성·재사용).
        await productsApi.update(productId, {
          ...fields,
          producer_name: producerName,
          variety_names: splitVarieties(values.varietyNames),
        });
        triggerSync();
        return;
      }

      const current = await db.product.get(productId);
      if (!current) throw new Error("제품을 찾을 수 없습니다");
      // 생산자는 오프라인 쓰기 대상이 아니라 새로 못 만든다 — 미러에 있으면 재사용하고,
      // 없으면 잃지 않게 메모로 보존한다.
      const producerId = producerName ? await resolveProducerIdOffline(producerName) : null;
      session.assertCurrent();
      const note =
        producerName && !producerId
          ? fields.note
            ? `${fields.note}\n생산자: ${producerName}`
            : `생산자: ${producerName}`
          : fields.note;
      await enqueue({
        entity: "product",
        op: "update",
        entityId: productId,
        baseUpdatedAt: current.updated_at as string,
        fields: { ...fields, producer_id: producerId, note },
        optimisticRow: {
          ...current,
          ...fields,
          producer_id: producerId,
          note,
          updated_at: new Date().toISOString(),
        },
      });
    },
    onSuccess: () => {
      clearFormDraft(`product:edit:${window.location.hash}`);
      setEditing(false);
    },
  });

  // 구매 추가·삭제·분할·규격 추가는 서버 상태 기준으로 병 라벨을 재배치하므로 온라인
  // 전용이다(ProductDetail 이 오프라인이면 버튼 자체를 숨긴다 — 여기 mutationFn 은 항상
  // 온라인 호출을 가정한다).
  const addPurchase = useSessionMutation({
    networkMode: "online",
    mutationFn: async (input: AddPurchaseInput, session) => {
      const vendorId = input.vendorName ? await resolveVendorId(input.vendorName, session) : null;
      session.assertCurrent();
      const submittedContext = contextSignature;
      await purchasesApi.create({
        sku_id: input.skuId,
        quantity: input.quantity,
        vendor_id: vendorId,
        purchased_on: input.purchasedOn || null,
        unit_list_price: input.unitListPrice || null,
        unit_paid_price: input.unitPaidPrice || null,
      });
      return { skuId: input.skuId, contextSignature: submittedContext };
    },
    onSuccess: (result, input) => {
      if (input.vendorName) setLastVendorName(input.vendorName);
      triggerSync();
      toast.show({ message: `구매 ${input.quantity}병을 추가했습니다` });
      setPendingPurchaseTarget(result);
    },
  });

  useEffect(() => {
    if (!pendingPurchaseTarget || addPurchase.isPending) return;
    if (pendingPurchaseTarget.contextSignature !== contextSignature) {
      setPendingPurchaseTarget(null);
      return;
    }
    if (!product?.skus.some((sku) => sku.id === pendingPurchaseTarget.skuId)) return;
    setPendingPurchaseTarget(null);
    onSelectContext({ skuId: pendingPurchaseTarget.skuId, purchaseScope: undefined });
  }, [pendingPurchaseTarget, contextSignature, product, addPurchase.isPending, onSelectContext]);

  const deletePurchase = useSessionMutation({
    networkMode: "online",
    mutationFn: (purchaseId: string) => purchasesApi.remove(purchaseId),
    onSuccess: () => triggerSync(),
  });

  async function updatePurchase(purchaseId: string, input: EditPurchaseInput): Promise<void> {
    const session = captureWriteSession();
    session.assertCurrent();
    const vendorId = input.vendorName ? await resolveVendorId(input.vendorName, session) : null;
    session.assertCurrent();
    await purchasesApi.update(purchaseId, {
      vendor_id: vendorId,
      purchased_on: input.purchasedOn || null,
      quantity: input.quantity,
      // 공란은 0원(D211) — 정가 공란은 할인율 계산에서 빠진다(D215).
      unit_list_price: input.unitListPrice || "0",
      unit_paid_price: input.unitPaidPrice || "0",
    });
    session.assertCurrent();
    if (input.vendorName) setLastVendorName(input.vendorName);
    triggerSync();
    toast.show({ message: "구매 기록을 고쳤습니다" });
  }

  const splitPurchase = useSessionMutation({
    networkMode: "online",
    mutationFn: async (
      { purchaseId, parts }: { purchaseId: string; parts: SplitPart[] },
      session,
    ) => {
      const resolvedParts = await Promise.all(
        parts.map(async (part) => {
          const vendorName = part.vendorName.trim();
          return {
            quantity: Number(part.quantity),
            vendor_id: vendorName ? await resolveVendorId(vendorName, session) : null,
          };
        }),
      );
      session.assertCurrent();
      await purchasesApi.split(purchaseId, resolvedParts);
    },
    onSuccess: () => triggerSync(),
  });

  const addSku = useSessionMutation({
    networkMode: "online",
    mutationFn: async (volumeMl: number, session) => {
      try {
        return await productsApi.addSku(productId, volumeMl);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        session.assertCurrent();
        const current = await productsApi.get(productId);
        session.assertCurrent();
        const existing = current.skus.find((sku) => sku.volume_ml === volumeMl);
        if (!existing) throw error;
        return existing;
      }
    },
    onSuccess: () => triggerSync(),
  });

  if (product === undefined || target === undefined) {
    return <LoadingState label="상세 정보를 불러오고 있습니다…" />;
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

  if (target === null) {
    return (
      <>
        <p role="alert" className="alert">
          선택한 규격·병·시음이 삭제되었거나 이 술에 속하지 않습니다.
        </p>
        <button type="button" onClick={() => onSelectContext({ purchaseScope: undefined })}>
          제품 전체 보기
        </button>
        <button type="button" onClick={onBack}>
          목록으로
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
      key={product.id}
      product={product}
      matchingPurchaseIds={matchingPurchaseIds}
      selectedSkuId={target.skuId}
      selectedBottleId={target.bottleId}
      selectedTastingId={target.tastingId}
      onSelectContext={onSelectContext}
      purchases={purchases ?? []}
      bottles={bottles ?? []}
      offline={offline}
      onBack={onBack}
      onEdit={() => setEditing(true)}
      onDelete={() => remove.mutate()}
      deleting={remove.isPending}
      onAddPurchase={(input) => addPurchase.mutateAsync(input)}
      addingPurchase={addPurchase.isPending}
      addPurchaseError={addPurchase.error}
      vendorNames={vendorNames}
      onDeletePurchase={(purchaseId) => deletePurchase.mutate(purchaseId)}
      onUpdatePurchase={offline ? undefined : updatePurchase}
      deletingPurchaseId={deletePurchase.isPending ? (deletePurchase.variables ?? null) : null}
      onSplitPurchase={(purchaseId, parts) => splitPurchase.mutate({ purchaseId, parts })}
      splittingPurchaseId={
        splitPurchase.isPending ? (splitPurchase.variables?.purchaseId ?? null) : null
      }
      splitError={splitPurchase.error}
      actionError={remove.error ?? deletePurchase.error ?? addSku.error}
      onAddSku={(volumeMl) => addSku.mutateAsync(volumeMl)}
      addingSku={addSku.isPending}
    />
  );
}

/** 결과가 없을 때 무엇 때문에 비었는지 보이도록 적용 중인 필터를 짧은 문구로 만든다. */
function describeActiveFilters(
  filters: ProductFilters,
  categories: { id: string; name: string }[],
  vendors: { id: string; name: string }[],
): string[] {
  const labels: string[] = [];
  if (filters.volume_ml !== undefined) labels.push(`용량 ${filters.volume_ml}ml`);
  if (filters.q) labels.push(`이름 "${filters.q}"`);
  if (filters.category_id)
    labels.push(`주종 ${categories.find((item) => item.id === filters.category_id)?.name ?? ""}`);
  if (filters.vendor_id)
    labels.push(`구매처 ${vendors.find((item) => item.id === filters.vendor_id)?.name ?? ""}`);
  if (filters.country) labels.push(`국가 ${filters.country}`);
  if (filters.variety) labels.push(`품종 ${filters.variety}`);
  if (filters.in_stock !== undefined) labels.push(filters.in_stock ? "재고 있음" : "재고 없음");
  if (filters.abv_min || filters.abv_max)
    labels.push(`도수 ${filters.abv_min ?? ""}~${filters.abv_max ?? ""}%`);
  if (filters.vintage_min || filters.vintage_max)
    labels.push(`빈티지 ${filters.vintage_min ?? ""}~${filters.vintage_max ?? ""}`);
  if (filters.rating_min) labels.push(`평점 ${filters.rating_min} 이상`);
  if (filters.price_per_100ml_min || filters.price_per_100ml_max)
    labels.push(
      `100ml당 ${filters.price_per_100ml_min ?? ""}~${filters.price_per_100ml_max ?? ""}원`,
    );
  if (filters.purchased_on_min || filters.purchased_on_max)
    labels.push(`구매일 ${filters.purchased_on_min ?? ""}~${filters.purchased_on_max ?? ""}`);
  return labels;
}

/** 목록 끝이 화면에 들어오면 다음 묶음을 자동으로 펼친다. "더 보기" 버튼은 보조로 남긴다. */
function LoadMoreSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="load-more-sentinel" aria-hidden="true" />;
}

/** 지금 필터·정렬된 목록 그대로 내보낸다(백업·엑셀 정리용). */
function exportProducts(products: Product[]): void {
  const { header, rows } = productCsvData(products);
  downloadCsv(`sooljang-products-${todayLocal()}.csv`, header, rows);
}
