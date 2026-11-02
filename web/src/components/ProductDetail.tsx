import { useLiveQuery } from "dexie-react-hooks";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bottle, ContextualTasting, Product, Purchase, Sku } from "@/api/types";
import { AutocompleteInput } from "@/components/AutocompleteInput";
import { BottleGauge } from "@/components/BottleGauge";
import { BottleSection } from "@/components/BottleSection";
import { useConfirm } from "@/components/ConfirmDialog";
import { ExternalInfoCard } from "@/components/ExternalInfoCard";
import { PriceHistoryPanel } from "@/components/PriceHistoryPanel";
import { ProductAttachments } from "@/components/ProductAttachments";
import { ProductTastingHistory } from "@/components/ProductTastingHistory";
import { type EditPurchaseInput, PurchaseEditForm } from "@/components/PurchaseEditForm";
import { PurchaseSkuCorrectionForm } from "@/components/PurchaseSkuCorrectionForm";
import {
  productEdition,
  productSkuSummaries,
  purchaseReference,
} from "@/components/productDisplay";
import { SkuMetricsTable } from "@/components/SkuMetricsTable";
import { TastingCorrectionForm } from "@/components/TastingCorrectionForm";
import { convertedPaidPrice, FOREIGN_CURRENCIES, foreignPriceMismatch } from "@/domain/purchaseFx";
import {
  formatAbv,
  formatCategoryPath,
  formatDate,
  formatMoney,
  formatPercent,
  formatRating,
  formatVolume,
  todayLocal,
} from "@/format";
import { keepInView } from "@/keepInView";
import { getLastVendorName } from "@/lastVendor";
import type { ProductContext, PurchaseHandoff } from "@/router";
import { rankByQuery } from "@/search";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { captureFormDraft, clearSubmittedDraft, useDraftState } from "@/sync/drafts";
import { getCorrectionOptions, getLocalTastingHistory } from "@/sync/tastingHistory";
import { captureWriteSession } from "@/sync/writeSession";

//: `ProductForm` 과 같은 값 — 405종 목록에서도 스크롤 없이 훑을 수 있는 후보 수.
const MAX_SUGGESTIONS = 8;

export interface AddPurchaseInput {
  skuId: string;
  quantity: number;
  vendorName: string;
  purchasedOn: string;
  unitListPrice: string;
  unitPaidPrice: string;
  /** 해외 구매. 실구매가(`unitPaidPrice`)는 외화 단가 × 환율의 원화 값이다. */
  foreign?: { currency: string; fxRate: string; foreignUnitPrice: string };
}

export interface SplitPart {
  quantity: string;
  vendorName: string;
}

interface ProductDetailProps {
  matchingPurchaseIds?: readonly string[] | undefined;
  selectedSkuId?: string | undefined;
  selectedPurchaseId?: string | undefined;
  selectedBottleId?: string | undefined;
  selectedTastingId?: string | undefined;
  editTasting?: boolean | undefined;
  /** 새 술 폼의 "이 술에 구매 추가"로 들어오면 구매 추가 폼을 열어 둔다(D268). */
  addPurchase?: boolean | undefined;
  /** `addPurchase`와 함께 넘어온 새 술 폼의 구매 칸(D273). */
  purchaseHandoff?: PurchaseHandoff | undefined;
  /** 구매 추가 요청을 받았다. 한 번 쓰는 표시라 다시 마운트돼도 폼을 또 열지 않게 소비한다. */
  onAddPurchaseDelivered?: (() => void) | undefined;
  onTastingDeleted?: ((item: ContextualTasting) => void) | undefined;
  onSelectContext?: ((context: ProductContext) => void) | undefined;
  onTastingCorrected?: ((tasting: ContextualTasting) => void) | undefined;
  onCorrectionSavingChange?: ((saving: boolean) => void) | undefined;
  product: Product;
  purchases: Purchase[];
  bottles: Bottle[];
  offline: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;

  onAddPurchase:
    | ((input: AddPurchaseInput) => void)
    | ((input: AddPurchaseInput) => Promise<unknown>);
  addingPurchase: boolean;
  addPurchaseError: unknown;
  /** 구매 추가 폼의 구매처 자동완성 후보. */
  vendorNames: string[];

  onDeletePurchase: (purchaseId: string) => void;
  deletingPurchaseId: string | null;

  onUpdatePurchase?: ((purchaseId: string, input: EditPurchaseInput) => Promise<void>) | undefined;

  onSplitPurchase: (purchaseId: string, parts: SplitPart[]) => void;
  splittingPurchaseId: string | null;
  splitError: unknown;

  onAddSku: (volumeMl: number) => Promise<Sku>;
  addingSku: boolean;
  /** 삭제·구매 삭제·규격 추가처럼 폼 밖에서 실패한 동작의 오류. */
  actionError?: unknown;
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 제품 상세.
 *
 * 파생 지표를 먼저 보여준다. 사용자가 이 화면에서 가장 자주 확인하는 것이 "이 술이 얼마짜리
 * 였는지" 와 "몇 병 남았는지" 다. 구매 이력은 그 근거이므로 아래에 둔다.
 *
 * "병 관리"가 원래 별도 탭이었는데, 전체 병을 술 구분 없이 평면 목록으로 보여줘 무슨
 * 술인지 알 수 없다는 문제가 있었다(사용자 실사용 보고) — 제품 상세 안으로 통합해
 * 애초에 이 문제가 생기지 않게 한다.
 *
 * 구매 추가·삭제·분할·규격 추가는 서버 상태 기준으로 병 라벨을 재배치하므로 온라인
 * 전용이다(`CategoriesPage` 의 reparent/merge 와 같은 판단).
 */
const RECENT_TASTINGS = 3;

/**
 * 머리부 "한 잔 기록"이 고를 병. 보고 있는 병이 마실 수 있으면 그 병, 아니면 보고 있는 규격의
 * 열린 병(최근 개봉), 오래된 미개봉 순이다(빠른 시음의 기본 병과 같은 순서).
 */
function pourTarget(
  bottles: readonly Bottle[],
  purchases: readonly Purchase[],
  bottleId: string | undefined,
  skuId: string | undefined,
): Bottle | null {
  const drinkable = (bottle: Bottle) => bottle.status === "open" || bottle.status === "unopened";
  const current = bottles.find((bottle) => bottle.id === bottleId);
  if (current && drinkable(current)) return current;
  const purchaseById = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const candidates = bottles.filter(drinkable);
  const inSku = candidates.filter(
    (bottle) => purchaseById.get(bottle.purchase_id)?.sku_id === skuId,
  );
  const pool = inSku.length > 0 ? inSku : candidates;
  const purchasedOn = (bottle: Bottle) =>
    purchaseById.get(bottle.purchase_id)?.purchased_on ?? null;
  return (
    [...pool].sort((a, b) => {
      const status = (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1);
      if (status) return status;
      if (a.status === "open")
        return (b.opened_on ?? "").localeCompare(a.opened_on ?? "") || a.label_no - b.label_no;
      const left = purchasedOn(a);
      const right = purchasedOn(b);
      return (
        (left === null ? 1 : 0) - (right === null ? 1 : 0) ||
        (left ?? "").localeCompare(right ?? "") ||
        a.label_no - b.label_no
      );
    })[0] ?? null
  );
}

function bottleVolume(
  bottle: Bottle,
  purchases: readonly Purchase[],
  skus: readonly Sku[],
): number | null {
  const purchase = purchases.find((item) => item.id === bottle.purchase_id);
  return purchase?.volume_ml ?? skus.find((sku) => sku.id === purchase?.sku_id)?.volume_ml ?? null;
}

/**
 * 머리부 병 이름. 병 번호는 구매마다 1부터 다시 매기므로 규격이 둘 이상이면 용량을, 같은 용량에
 * 같은 번호의 다른 마실 병이 있으면 구매일·구매처를 덧붙인다(D264).
 */
function pourTargetLabel(
  target: Bottle,
  bottles: readonly Bottle[],
  purchases: readonly Purchase[],
  skus: readonly Sku[],
): string {
  const volume = bottleVolume(target, purchases, skus);
  const amount =
    target.status === "unopened"
      ? "미개봉"
      : target.remaining_ml === null
        ? "잔량 미기록"
        : `${target.remaining_ml.toLocaleString("ko-KR")}ml 남음`;
  const size = skus.length > 1 && volume !== null ? `${formatVolume(volume)} ` : "";
  const collides = bottles.some(
    (bottle) =>
      bottle.id !== target.id &&
      (bottle.status === "open" || bottle.status === "unopened") &&
      bottle.label_no === target.label_no &&
      bottleVolume(bottle, purchases, skus) === volume,
  );
  // 홈 열린 병과 같은 "구매 날짜 · 구매처"로 구분한다(레거시 구매는 날짜가 없을 수 있다).
  const bought = purchases.find((item) => item.id === target.purchase_id);
  const purchase = collides
    ? ` · 구매 ${formatDate(bought?.purchased_on)} · ${bought?.vendor_name ?? "구매처 미기록"}`
    : "";
  return `${amount} · ${size}${target.label_no}번 병${purchase}`;
}

export function ProductDetail({
  product,
  purchases,
  bottles,
  matchingPurchaseIds,
  selectedSkuId,
  selectedPurchaseId,
  selectedBottleId,
  selectedTastingId,
  editTasting,
  addPurchase,
  purchaseHandoff,
  onAddPurchaseDelivered,
  onTastingDeleted,
  onSelectContext,
  onTastingCorrected,
  onCorrectionSavingChange,
  offline,
  onBack,
  onEdit,
  onDelete,
  deleting,
  onAddPurchase,
  addingPurchase,
  addPurchaseError,
  vendorNames,
  onDeletePurchase,
  deletingPurchaseId,
  onUpdatePurchase,
  onSplitPurchase,
  splittingPurchaseId,
  splitError,
  onAddSku,
  addingSku,
  actionError,
}: ProductDetailProps) {
  const confirm = useConfirm();
  const { metrics } = product;
  const matchingScope = matchingPurchaseIds ? [...matchingPurchaseIds].sort().join(":") : null;
  const [allHistoryScope, setAllHistoryScope] = useState<string | null>(null);
  const matchingOnly = matchingScope !== null && allHistoryScope !== matchingScope;
  const visibleMatchingIds = matchingOnly ? matchingPurchaseIds : undefined;
  const scopedBottles = matchingOnly
    ? bottles.filter((bottle) => matchingPurchaseIds?.includes(bottle.purchase_id))
    : bottles;
  const [localContext, setLocalContext] = useState<ProductContext>({});
  const contextSkuId = selectedSkuId ?? localContext.skuId;
  const contextPurchaseId = selectedPurchaseId ?? localContext.purchaseId;
  const contextBottleId = selectedBottleId ?? localContext.bottleId;
  const contextTastingId = selectedTastingId ?? localContext.tastingId;
  const selectedBottle = bottles.find((bottle) => bottle.id === contextBottleId);
  const activeSkuId =
    contextSkuId ??
    purchases.find((purchase) => purchase.id === contextPurchaseId)?.sku_id ??
    purchases.find((purchase) => purchase.id === selectedBottle?.purchase_id)?.sku_id;
  const selectedSku = product.skus.find((sku) => sku.id === activeSkuId);
  const selectedSummary = productSkuSummaries(product)?.find(
    (row) =>
      row.sku_id === (activeSkuId ?? (product.skus.length === 1 ? product.skus[0]?.id : undefined)),
  );
  const [savingBottleContext, setSavingBottleContext] = useState<string | null>(null);
  const bottleContextKey = `${product.id}:${activeSkuId ?? ""}:${contextBottleId ?? ""}`;
  const savingBottle = savingBottleContext === bottleContextKey;
  const setSavingBottle = useCallback(
    (saving: boolean) => setSavingBottleContext(saving ? bottleContextKey : null),
    [bottleContextKey],
  );
  const selectContext = (context: ProductContext) => {
    if (savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku) return;
    if (onSelectContext) onSelectContext(context);
    else setLocalContext(context);
  };
  const [savingTarget, setSavingTarget] = useState<string | null>(null);
  const savingPurchase = savingTarget === product.id;
  const setSavingPurchase = useCallback(
    (saving: boolean) => setSavingTarget(saving ? product.id : null),
    [product.id],
  );
  const [priceHistoryOpen, setPriceHistoryOpen] = useState(false);
  const [externalInfoOpen, setExternalInfoOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(Boolean(contextTastingId));
  const [correctionPurchaseId, setCorrectionPurchaseId] = useState<string | null>(null);
  const [correctionTastingId, setCorrectionTastingId] = useState<string | null>(null);
  const [savingCorrection, setCorrectionPending] = useState(false);
  const setSavingCorrection = useCallback(
    (saving: boolean) => {
      setCorrectionPending(saving);
      onCorrectionSavingChange?.(saving);
    },
    [onCorrectionSavingChange],
  );
  const correctionOptions = useLiveQuery(
    async () => (correctionTastingId ? getCorrectionOptions() : undefined),
    [correctionTastingId],
  );
  const purchaseCorrectionRef = useRef<HTMLDivElement>(null);
  const tastingCorrectionRef = useRef<HTMLElement>(null);
  // 제품 전체 시음(최근 순)과 요약. 머리부 시음 평균과 병 구역의 최근 시음이 같이 쓴다. 로컬
  // 기록이라 방금 저장한 시음도 동기화 전에 반영된다. 평균은 이력 요약과 같은 값(Decimal 짝수
  // 반올림, 서버와 같은 규칙)이라 같은 화면의 평균 평점과 어긋나지 않는다.
  // 읽기 실패는 null이다. 그대로 던지면 상세 화면 전체가 오류 화면으로 바뀐다.
  const productHistory = useLiveQuery(
    () => getLocalTastingHistory({ product_id: product.id }).catch(() => null),
    [product.id],
  );
  const productTastings = productHistory?.items;
  const tastingSummary = productHistory?.summary;
  const target = pourTarget(scopedBottles, purchases, contextBottleId, activeSkuId);
  const busy = savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku;
  // "한 잔 기록": 병을 펼친 뒤 그 병의 시음 입력으로 옮긴다. 빠른 시음 시트를 겹쳐 열지 않는다
  // (같은 병 초안을 두 폼이 따로 들고 서로 덮어쓰게 된다).
  const [pourBottleId, setPourBottleId] = useState<string | null>(null);
  useEffect(() => {
    if (!pourBottleId || contextBottleId !== pourBottleId) return;
    const heading = document.querySelector<HTMLElement>(`#tasting-form-${pourBottleId} h4`);
    if (!heading) return;
    setPourBottleId(null);
    heading.scrollIntoView?.({ block: "start" });
    heading.focus({ preventScroll: true });
  });
  // 구매 추가 요청과 그 요청에 실려 온 새 술 폼의 구매 칸. 넘긴 값은 그 요청에서 한 번만 쓰고,
  // 머리부 "구매 추가"는 넘긴 값 없이 연다(D273).
  const [addPurchaseRequest, setAddPurchaseRequest] = useState<AddPurchaseRequest>({
    count: 0,
    handoff: null,
  });
  const addPurchaseDelivered = useRef(onAddPurchaseDelivered);
  addPurchaseDelivered.current = onAddPurchaseDelivered;
  const purchaseHandoffRef = useRef(purchaseHandoff);
  purchaseHandoffRef.current = purchaseHandoff;
  useEffect(() => {
    if (!addPurchase) return;
    setAddPurchaseRequest((request) => ({
      count: request.count + 1,
      handoff: purchaseHandoffRef.current ?? null,
    }));
    addPurchaseDelivered.current?.();
  }, [addPurchase]);
  useEffect(() => {
    if (editTasting && contextTastingId) setCorrectionTastingId(contextTastingId);
  }, [editTasting, contextTastingId]);
  useEffect(() => {
    if (contextTastingId) setHistoryOpen(true);
  }, [contextTastingId]);
  useEffect(() => {
    if (correctionPurchaseId) purchaseCorrectionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [correctionPurchaseId]);
  // 정정 폼이 목적지다(토스트 "고치기"·목록의 "수정"). 늦게 불러온 병·이력 목록이 고른 시음 행으로
  // 초점을 가져가거나 자라면서 폼을 화면 아래로 밀지 않게 한다.
  const correcting = Boolean(correctionTastingId) || Boolean(editTasting && contextTastingId);
  useEffect(() => {
    const section = tastingCorrectionRef.current;
    if (!correctionTastingId || !section) return;
    section.focus({ preventScroll: true });
    return keepInView(section);
  }, [correctionTastingId]);

  const correctionTrigger = useRef<HTMLElement | null>(null);
  const historySummaryRef = useRef<HTMLElement>(null);
  const correctTasting = (tasting: ContextualTasting) => {
    if (savingCorrection) return;
    correctionTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCorrectionTastingId(tasting.id);
  };
  // 정정 폼을 닫으면 폼 안에 있던 초점이 body로 떨어진다. 연 단추 → 그 시음의 이력·병 행 → 이력
  // 요약 순으로 돌린다(토스트 "고치기"로 왔으면 연 단추가 이 화면에 없다).
  const cancelCorrection = (tastingId: string) => {
    const trigger = correctionTrigger.current;
    correctionTrigger.current = null;
    setCorrectionTastingId(null);
    for (const element of [
      trigger,
      document.getElementById(`history-tasting-${tastingId}`),
      document.getElementById(`tasting-${tastingId}`),
      historySummaryRef.current,
    ]) {
      if (!element?.isConnected || tastingCorrectionRef.current?.contains(element)) continue;
      element.focus();
      if (document.activeElement === element) return;
    }
  };
  const tastingDeleted = (tasting: ContextualTasting) => {
    if (correctionTastingId === tasting.id) setCorrectionTastingId(null);
    if (onTastingDeleted) onTastingDeleted(tasting);
    else if (contextTastingId === tasting.id) {
      const next = {
        skuId: contextSkuId ?? tasting.sku_id,
        purchaseId: contextPurchaseId,
        bottleId: contextBottleId ?? tasting.bottle_id ?? undefined,
      };
      if (onSelectContext) onSelectContext(next);
      else setLocalContext(next);
    }
  };

  return (
    <article aria-labelledby="detail-heading">
      <div className="detail-toolbar">
        <button
          type="button"
          className="btn-quiet"
          disabled={
            savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku
          }
          onClick={onBack}
        >
          ← 목록으로
        </button>
        <div className="button-row">
          <button
            type="button"
            disabled={
              savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku
            }
            onClick={onEdit}
          >
            수정
          </button>
          <div className="overflow-menu">
            <button
              ref={moreButtonRef}
              type="button"
              aria-label="더 보기"
              aria-expanded={moreOpen}
              aria-controls="product-more-menu"
              onClick={() => setMoreOpen((open) => !open)}
            >
              ⋯
            </button>
            {moreOpen ? (
              <div id="product-more-menu" className="overflow-menu-panel">
                {/* 삭제는 자주 쓰지 않고 되돌리기 어렵다 — 수정 바로 옆에 두지 않는다. */}
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    const bottleCount = bottles.length;
                    const message =
                      purchases.length > 0
                        ? `"${product.name}"과 구매 ${purchases.length}건·병 ${bottleCount}개를 함께 삭제할까요?`
                        : `"${product.name}"을 삭제할까요?`;
                    setMoreOpen(false);
                    void confirm({
                      title: "제품 삭제",
                      message,
                      confirmLabel: "삭제",
                      danger: true,
                      // 메뉴가 접히며 이 버튼은 사라진다. 닫힌 뒤에는 메뉴 버튼으로 돌아간다.
                      returnFocus: moreButtonRef.current,
                    }).then((confirmed) => {
                      if (confirmed) onDelete();
                    });
                  }}
                  disabled={
                    deleting ||
                    savingBottle ||
                    savingPurchase ||
                    savingCorrection ||
                    addingPurchase ||
                    addingSku
                  }
                >
                  {deleting ? "삭제 중…" : "삭제"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {errorText(actionError) ? (
        <p className="alert" role="alert">
          {errorText(actionError)}
        </p>
      ) : null}

      <header className="panel product-hero">
        <h2 id="detail-heading" className="product-hero-title">
          {product.name}
          {product.vintage !== null && <span className="muted"> ({product.vintage})</span>}
        </h2>
        <p className="muted mt-0">
          {formatCategoryPath(product.category_path)}
          {product.producer_name && ` · ${product.producer_name}`}
          {product.country && ` · ${product.country}`}
        </p>
        <ul className="chip-row" aria-label="제품 정보">
          <li className="chip">
            <span className="muted">도수</span> {formatAbv(product.abv)}
          </li>
          <li className="chip">
            <span className="muted">규격</span>{" "}
            {product.skus.length === 0
              ? "등록된 규격 없음"
              : product.skus.map((sku) => formatVolume(sku.volume_ml)).join(", ")}
          </li>
          {product.varieties.length > 0 ? (
            <li className="chip">
              <span className="muted">품종·스타일</span> {product.varieties.join(", ")}
            </li>
          ) : null}
        </ul>
        {product.note && <p className="pre-wrap mb-0">{product.note}</p>}
        <div className="product-hero-pour">
          {target ? (
            <BottleGauge
              status={target.status}
              remainingMl={target.remaining_ml}
              volumeMl={bottleVolume(target, purchases, product.skus)}
            />
          ) : null}
          <p className="mb-0">
            {target
              ? pourTargetLabel(target, bottles, purchases, product.skus)
              : "마실 수 있는 병이 없습니다"}
          </p>
        </div>
        {/* 제품에 매긴 평점과 시음 평점의 평균은 다른 값이라 이름을 나눠 보인다(D268). */}
        <dl className="product-hero-ratings">
          <div>
            <dt>내 평점</dt>
            <dd>{formatRating(product.personal_rating)}</dd>
          </div>
          <div>
            <dt>시음 평균</dt>
            <dd>
              {productHistory === null ? "확인 불가" : formatRating(tastingSummary?.average_rating)}
              {tastingSummary && tastingSummary.rated_count > 0 ? (
                <span className="muted text-sm"> · {tastingSummary.rated_count}회 평가</span>
              ) : null}
            </dd>
          </div>
        </dl>
        <div className="button-row product-hero-actions">
          {target ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                const skuId = purchases.find(
                  (purchase) => purchase.id === target.purchase_id,
                )?.sku_id;
                setPourBottleId(target.id);
                selectContext({ ...(skuId ? { skuId } : {}), bottleId: target.id });
              }}
            >
              한 잔 기록
            </button>
          ) : null}
          {offline ? null : (
            <button
              type="button"
              className={target ? undefined : "primary"}
              disabled={busy}
              onClick={() =>
                setAddPurchaseRequest((request) => ({ count: request.count + 1, handoff: null }))
              }
            >
              구매 추가
            </button>
          )}
        </div>
      </header>

      <section aria-labelledby="detail-metrics-heading">
        <h3 id="detail-metrics-heading" className="sr-only">
          구매 기록에서 계산한 지표
        </h3>
        <dl className="metrics-grid metrics-grid--hero">
          <Metric
            label="재고"
            value={`${metrics.in_stock_count}병`}
            hint={`${product.skus.length > 1 ? "전체 규격 · " : ""}미개봉 ${metrics.unopened_count} · 개봉 ${metrics.opened_count}`}
          />
          <Metric
            label="실평단가"
            value={formatMoney(metrics.avg_paid_price)}
            hint={product.skus.length > 1 ? "전체 용량 구매 평균" : undefined}
          />
          <Metric
            label="100ml당 가격"
            value={formatMoney(metrics.price_per_100ml)}
            hint={product.skus.length > 1 ? "전체 용량 · 정가 기준" : "정가 기준"}
          />
        </dl>
        <details className="metrics-more">
          <summary>지표 더 보기</summary>
          <dl className="metrics-grid">
            <Metric label="구매 병수" value={`${metrics.purchased_count}병`} />
            <Metric label="소진 병수" value={`${metrics.consumed_count}병`} />
            <Metric label="평단가" value={formatMoney(metrics.avg_list_price)} hint="정가" />
            <Metric label="할인율" value={formatPercent(metrics.discount_rate)} />
            <Metric label="총 지출" value={formatMoney(metrics.paid_total)} />
            <Metric
              label="재고 자산가치"
              value={formatMoney(metrics.inventory_value_at_cost)}
              hint="규격별 실평단가 × 재고 병 수의 합계"
            />
          </dl>
          <p className="muted text-sm">
            모두 구매 기록에서 계산합니다. 가격 공란은 0원, 할인율은 정가가 기록된 구매만 씁니다.
          </p>
        </details>
      </section>

      <SkuMetricsTable
        product={product}
        selectedSkuId={activeSkuId}
        onSelect={(skuId) => selectContext(skuId ? { skuId } : {})}
        disabled={savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku}
      />
      {selectedSku ? (
        <output className="selected-sku-context">
          {formatVolume(selectedSku.volume_ml)}의 구매·병을 보고 있습니다.
        </output>
      ) : null}

      {matchingScope !== null ? (
        <fieldset className="panel" aria-label="구매 이력 범위">
          <div className="button-row">
            <button
              type="button"
              aria-pressed={matchingOnly}
              disabled={
                savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku
              }
              onClick={() => setAllHistoryScope(null)}
            >
              선택 조건
            </button>
            <button
              type="button"
              aria-pressed={!matchingOnly}
              disabled={
                savingBottle || savingPurchase || savingCorrection || addingPurchase || addingSku
              }
              onClick={() => setAllHistoryScope(matchingScope)}
            >
              전체 구매 이력
            </button>
          </div>
          <p className="muted mb-0">
            {matchingOnly
              ? "선택 조건에 맞는 구매와 그 병만 표시합니다. 다른 규격은 전체 구매 이력에서 확인하세요."
              : "선택 조건을 풀고 전체 구매 이력을 표시합니다."}{" "}
            제품 지표와 규격별 요약은 전체 이력 기준입니다.
          </p>
        </fieldset>
      ) : null}
      <nav className="detail-jump button-row" aria-label="상세 구역 바로가기">
        {(
          [
            ["detail-bottles", "병·시음"],
            ["detail-purchases", "구매"],
            ["detail-prices", "가격·외부"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => document.getElementById(id)?.scrollIntoView?.({ block: "start" })}
          >
            {label}
          </button>
        ))}
      </nav>
      {/* 가장 잦은 일(병 상태·시음)을 구매 이력보다 먼저 둔다. */}
      <div id="detail-bottles" className="detail-anchor">
        {productHistory === null ? (
          <p role="alert">기기의 시음 기록을 불러오지 못했습니다.</p>
        ) : null}
        {productTastings && productTastings.length > 0 ? (
          <section aria-labelledby="detail-recent-tastings" className="detail-recent-tastings">
            <h3 id="detail-recent-tastings">최근 시음</h3>
            <ul className="detail-tasting-list">
              {productTastings.slice(0, RECENT_TASTINGS).map((tasting) => (
                <li key={tasting.id}>
                  <button
                    type="button"
                    aria-current={tasting.id === contextTastingId ? "true" : undefined}
                    disabled={busy}
                    onClick={() =>
                      selectContext({
                        skuId: tasting.sku_id,
                        bottleId: tasting.bottle_id ?? undefined,
                        tastingId: tasting.id,
                      })
                    }
                  >
                    <span>{formatDate(tasting.tasted_on)}</span>
                    <span>
                      {tasting.rating === null ? "평점 없음" : formatRating(tasting.rating)}
                    </span>
                    <span className="muted text-sm">
                      {[
                        tasting.poured_ml === null ? null : `${tasting.poured_ml}ml`,
                        tasting.bottle?.label_no === undefined || tasting.bottle?.label_no === null
                          ? null
                          : `${tasting.bottle.label_no}번 병`,
                        tasting.note || null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {matchingOnly && scopedBottles.length === 0 ? (
          <output className="notice">
            선택 조건에 맞는 병이 없습니다. 전체 구매 이력에서 확인하세요.
          </output>
        ) : (
          <BottleSection
            product={product}
            bottles={scopedBottles}
            purchases={purchases}
            offline={offline}
            selectedSkuId={activeSkuId}
            selectedBottleId={contextBottleId}
            selectedTastingId={contextTastingId}
            focusSelectedTasting={!correcting}
            onCorrectTasting={correctTasting}
            onTastingDeleted={tastingDeleted}
            onSelectContext={selectContext}
            onSavingChange={setSavingBottle}
          />
        )}

        <details
          className="panel mt-2"
          open={historyOpen}
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary ref={historySummaryRef}>시음 기록 찾기·정정</summary>
          {historyOpen ? (
            <ProductTastingHistory
              productId={product.id}
              selectedSkuId={activeSkuId}
              selectedBottleId={contextBottleId}
              selectedTastingId={contextTastingId}
              focusSelected={!correcting}
              offline={offline}
              correctionPending={savingCorrection}
              onCorrect={correctTasting}
              onDeleted={tastingDeleted}
              onSelectTasting={(tasting) =>
                selectContext({
                  skuId: tasting.sku_id,
                  bottleId: tasting.bottle_id ?? undefined,
                  tastingId: tasting.id,
                })
              }
            />
          ) : null}
        </details>
        {correctionTastingId ? (
          <section
            ref={tastingCorrectionRef}
            aria-label="시음 기록 정정"
            tabIndex={-1}
            className="detail-anchor"
          >
            <TastingCorrectionForm
              key={correctionTastingId}
              tastingId={correctionTastingId}
              offline={offline}
              bottleOptions={correctionOptions?.bottles}
              skuOptions={correctionOptions?.skus}
              onSavingChange={setSavingCorrection}
              onCancel={() => {
                if (!savingCorrection) cancelCorrection(correctionTastingId);
              }}
              onSaved={(result) => {
                setSavingCorrection(false);
                setCorrectionTastingId(null);
                if (onTastingCorrected) onTastingCorrected(result);
                else {
                  const next = {
                    skuId: result.sku_id,
                    bottleId: result.bottle_id ?? undefined,
                    tastingId: result.id,
                    purchaseScope: undefined,
                  };
                  if (onSelectContext) onSelectContext(next);
                  else setLocalContext(next);
                }
              }}
            />
          </section>
        ) : null}
      </div>
      <div id="detail-purchases" className="detail-anchor">
        <PurchaseSection
          matchingPurchaseIds={visibleMatchingIds}
          key={`purchase:${product.id}`}
          onSavingChange={setSavingPurchase}
          selectedSkuId={activeSkuId}
          selectedPurchaseId={contextPurchaseId}
          product={product}
          purchases={purchases}
          offline={offline}
          onAddPurchase={onAddPurchase}
          addingPurchase={addingPurchase}
          addPurchaseError={addPurchaseError}
          vendorNames={vendorNames}
          onDeletePurchase={onDeletePurchase}
          deletingPurchaseId={deletingPurchaseId}
          onUpdatePurchase={onUpdatePurchase}
          onSplitPurchase={onSplitPurchase}
          splittingPurchaseId={splittingPurchaseId}
          splitError={splitError}
          onAddSku={onAddSku}
          addingSku={addingSku}
          openAddRequest={addPurchaseRequest}
          correctionPending={savingCorrection}
          onCorrectSku={(id) => {
            if (!savingCorrection) setCorrectionPurchaseId(id);
          }}
        />

        {correctionPurchaseId ? (
          <div ref={purchaseCorrectionRef}>
            <PurchaseSkuCorrectionForm
              key={correctionPurchaseId}
              purchaseId={correctionPurchaseId}
              offline={offline}
              onSavingChange={setSavingCorrection}
              onCancel={() => {
                if (!savingCorrection) setCorrectionPurchaseId(null);
              }}
              onSaved={() => {
                setSavingCorrection(false);
                setCorrectionPurchaseId(null);
                const next = { purchaseScope: undefined };
                if (onSelectContext) onSelectContext(next);
                else setLocalContext(next);
              }}
            />
          </div>
        ) : null}
      </div>
      <ProductAttachments key={product.id} productId={product.id} offline={offline} />

      <div id="detail-prices" className="detail-anchor">
        <details
          className="panel mt-2"
          onToggle={(event) => setPriceHistoryOpen(event.currentTarget.open)}
        >
          <summary>가격 이력 보기</summary>
          {priceHistoryOpen && (
            <PriceHistoryPanel
              key={product.id}
              productId={product.id}
              onSaveInterest={() => setExternalInfoOpen(true)}
            />
          )}
        </details>
        {product.skus.length > 1 ? (
          <p className="muted text-sm">
            {selectedSummary
              ? `${formatVolume(selectedSummary.volume_ml)}의 전체 구매 실평단가를 외부 제안과 비교합니다.`
              : "내 가격과 비교하려면 용량을 선택하세요."}
          </p>
        ) : null}
        <ExternalInfoCard
          open={externalInfoOpen}
          onOpenChange={setExternalInfoOpen}
          productId={product.id}
          productName={product.name}
          offline={offline}
          myPricePer100ml={selectedSummary?.metrics.price_per_100ml_paid ?? null}
          selectedVolumeMl={selectedSummary?.volume_ml ?? null}
        />
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="metric">
      <dt>
        {label}
        {hint && <span className="muted"> ({hint})</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

// --- 구매 이력 ----------------------------------------------------------------

function PurchaseSection({
  product,
  matchingPurchaseIds,
  selectedSkuId,
  selectedPurchaseId,
  purchases,
  offline,
  onAddPurchase,
  addingPurchase,
  addPurchaseError,
  vendorNames,
  onDeletePurchase,
  deletingPurchaseId,
  onUpdatePurchase,
  onSplitPurchase,
  splittingPurchaseId,
  splitError,
  onAddSku,
  addingSku,
  onSavingChange,
  onCorrectSku,
  correctionPending,
  openAddRequest,
}: {
  onCorrectSku: (purchaseId: string) => void;
  correctionPending: boolean;
  /** 머리부 "구매 추가"·새 술 폼에서 온 요청. 바뀔 때마다 폼을 열고 그리로 옮긴다. */
  openAddRequest: AddPurchaseRequest;
  onSavingChange: (saving: boolean) => void;
  product: Product;
  matchingPurchaseIds?: readonly string[] | undefined;
  selectedSkuId?: string | undefined;
  selectedPurchaseId?: string | undefined;
  purchases: Purchase[];
  offline: boolean;
  onAddPurchase:
    | ((input: AddPurchaseInput) => void)
    | ((input: AddPurchaseInput) => Promise<unknown>);
  addingPurchase: boolean;
  addPurchaseError: unknown;
  vendorNames: string[];
  onDeletePurchase: (purchaseId: string) => void;
  deletingPurchaseId: string | null;
  onUpdatePurchase?: ((purchaseId: string, input: EditPurchaseInput) => Promise<void>) | undefined;
  onSplitPurchase: (purchaseId: string, parts: SplitPart[]) => void;
  splittingPurchaseId: string | null;
  splitError: unknown;
  onAddSku: (volumeMl: number) => Promise<Sku>;
  addingSku: boolean;
}) {
  const confirm = useConfirm();
  const visiblePurchases = purchases.filter(
    (purchase) =>
      (!selectedSkuId || purchase.sku_id === selectedSkuId) &&
      (!matchingPurchaseIds || matchingPurchaseIds.includes(purchase.id)),
  );
  const purchaseIdentities = purchases.map((purchase) => ({
    id: purchase.id,
    volumeMl:
      purchase.volume_ml ?? product.skus.find((sku) => sku.id === purchase.sku_id)?.volume_ml,
    purchasedOn: purchase.purchased_on,
    vendorName: purchase.vendor_name,
  }));
  function referenceOf(purchaseId: string): string | null {
    const identity = purchaseIdentities.find((purchase) => purchase.id === purchaseId);
    return identity ? purchaseReference(identity, purchaseIdentities) : null;
  }
  const hasSelectedPurchase = visiblePurchases.some(
    (purchase) => purchase.id === selectedPurchaseId,
  );
  const selectedPurchaseRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!selectedPurchaseId || !hasSelectedPurchase) return;
    selectedPurchaseRef.current?.focus({ preventScroll: true });
    selectedPurchaseRef.current?.scrollIntoView?.({ block: "center" });
  }, [selectedPurchaseId, hasSelectedPurchase]);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ pending: boolean; error: unknown }>({
    pending: false,
    error: null,
  });
  const flight = useRef(false);
  const mounted = useRef(true);
  const [skuSaving, setSkuSaving] = useState(false);
  const [addingLocally, setAddingLocally] = useState(false);
  // 넘겨받은 구매 칸. 이 술에 작성 중인 구매 입력이 있으면 섞지 않는다(applied: false, D273).
  const [prefill, setPrefill] = useState<HandoffPrefill | null>(null);
  const addHandoff = useRef<PurchaseHandoff | null>(null);
  const addSnapshot = useRef<ReturnType<typeof captureFormDraft> | null>(null);
  const promiseAdding = useRef(false);
  const wasAdding = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (wasAdding.current && !addingPurchase && !promiseAdding.current) {
      if (!addPurchaseError && addHandoff.current) clearSubmittedDraft(addHandoff.current.draft);
      if (!addPurchaseError && addSnapshot.current && clearSubmittedDraft(addSnapshot.current)) {
        setAddFormOpen(false);
        setPrefill(null);
      }
      flight.current = false;
      setAddingLocally(false);
      onSavingChange(false);
    }
    wasAdding.current = addingPurchase;
  }, [addingPurchase, addPurchaseError, onSavingChange]);
  const busy =
    editing.pending ||
    addingPurchase ||
    addingLocally ||
    skuSaving ||
    addingSku ||
    correctionPending;
  // 요청마다 한 번만 연다. 온라인 상태가 바뀌어 다시 실행돼도 사용자가 닫은 폼을 다시 열지 않는다.
  const handledAddRequest = useRef(0);
  const [focusAddRequest, setFocusAddRequest] = useState(0);
  const addFormRef = useRef<HTMLDivElement>(null);
  const offlineNoteRef = useRef<HTMLParagraphElement>(null);
  const addFormOpenRef = useRef(addFormOpen);
  addFormOpenRef.current = addFormOpen;
  useEffect(() => {
    const { count, handoff } = openAddRequest;
    if (!count || handledAddRequest.current === count) return;
    handledAddRequest.current = count;
    // 이미 열린 폼은 그대로 두고 그리로 옮기기만 한다. 적던 값·넘겨받은 값 안내를 다른 요청이
    // 바꾸지 않는다.
    if (!offline && !busy && !addFormOpenRef.current) {
      setPrefill(handoff ? { handoff, applied: prepareHandoffFill(product.id) } : null);
      setAddFormOpen(true);
    }
    setFocusAddRequest((request) => request + 1);
  }, [openAddRequest, offline, busy, product.id]);
  useEffect(() => {
    if (!focusAddRequest) return;
    // 오프라인이면 빈 폼 대신 온라인에서만 된다는 안내로 옮긴다.
    const target = addFormRef.current?.querySelector("form") ?? offlineNoteRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    return keepInView(target);
  }, [focusAddRequest]);

  function submitPurchase(input: AddPurchaseInput): void {
    if (flight.current || busy) return;
    flight.current = true;
    setAddingLocally(true);
    onSavingChange(true);
    const session = captureWriteSession();
    const snapshot = captureFormDraft(`purchase:${product.id}`);
    addSnapshot.current = snapshot;
    const handedOff = prefill?.applied ? prefill.handoff : null;
    addHandoff.current = handedOff;
    const result = onAddPurchase({ ...input });
    if (result && typeof result.then === "function") {
      promiseAdding.current = true;
      void result
        .then(() => {
          // 넘겨받은 칸으로 구매를 저장했다. 넘긴 뒤 그대로인 새 술 초안만 지운다(D273).
          if (handedOff) clearSubmittedDraft(handedOff.draft);
          const cleared = clearSubmittedDraft(snapshot);
          if (mounted.current && session.isCurrent() && cleared) {
            setAddFormOpen(false);
            setPrefill(null);
          }
        })
        .catch(() => {
          // The parent's mutation exposes the error and preserves the draft.
        })
        .finally(() => {
          if (!mounted.current || !session.isCurrent()) return;
          promiseAdding.current = false;
          flight.current = false;
          setAddingLocally(false);
          onSavingChange(false);
        });
    }
  }

  return (
    <section aria-labelledby="detail-purchases-heading">
      <div className="section-header">
        <h3 id="detail-purchases-heading">구매 이력</h3>
        {!offline && (
          <button
            type="button"
            disabled={busy || addingSku}
            onClick={() => {
              if (flight.current) return;
              setPrefill(null);
              setAddFormOpen((open) => !open);
            }}
          >
            {addFormOpen ? "취소" : "구매 추가"}
          </button>
        )}
      </div>
      {offline && (
        <p ref={offlineNoteRef} tabIndex={-1} className="muted text-sm detail-anchor">
          구매 추가·삭제·분할은 온라인일 때만 할 수 있습니다.
        </p>
      )}

      {addFormOpen && (
        <div ref={addFormRef} className="detail-anchor">
          <AddPurchaseForm
            key={product.id}
            product={product}
            selectedSkuId={selectedSkuId}
            prefill={prefill}
            onSavingChange={(saving) => {
              setSkuSaving(saving);
              onSavingChange(saving);
            }}
            onSubmit={submitPurchase}
            onAddSku={onAddSku}
            addingSku={addingSku}
            submitting={addingPurchase || addingLocally}
            error={addPurchaseError}
            vendorNames={vendorNames}
          />
        </div>
      )}

      {visiblePurchases.length === 0 ? (
        <output className="notice">
          {purchases.length > 0
            ? "선택한 조건·규격에 맞는 구매 기록이 없습니다. 전체 구매 이력을 확인하세요."
            : "구매 기록이 없습니다. 같은 술을 여러 번 샀다면 구매 건을 각각 추가해 구매처와 가격을 따로 남길 수 있습니다."}
        </output>
      ) : (
        <div className="table-scroll table-scroll--always">
          <table className="product-table purchase-table purchase-cards">
            <caption className="sr-only">구매 이력</caption>
            <thead>
              <tr>
                <th scope="col">규격 · 판본 · 구매 건</th>
                <th scope="col">구매일</th>
                <th scope="col">구매처</th>
                <th scope="col" className="numeric">
                  병수
                </th>
                <th scope="col" className="numeric">
                  병당 정가
                </th>
                <th scope="col" className="numeric">
                  병당 실구매가
                </th>
                <th scope="col" className="numeric">
                  총 지출
                </th>
                {!offline && <th scope="col">관리</th>}
              </tr>
            </thead>
            <tbody>
              {visiblePurchases.map((purchase) => (
                <Fragment key={purchase.id}>
                  <tr
                    ref={purchase.id === selectedPurchaseId ? selectedPurchaseRef : undefined}
                    tabIndex={purchase.id === selectedPurchaseId ? -1 : undefined}
                    aria-current={purchase.id === selectedPurchaseId ? "true" : undefined}
                    className={purchase.id === selectedPurchaseId ? "sku-selected" : undefined}
                  >
                    <td className="purchase-identity" data-label="규격 · 판본 · 구매 건">
                      {purchase.id === selectedPurchaseId ? <strong>선택한 구매</strong> : null}
                      <span>
                        {formatVolume(
                          purchase.volume_ml ??
                            product.skus.find((sku) => sku.id === purchase.sku_id)?.volume_ml,
                        )}
                      </span>
                      <span className="purchase-context">{productEdition(product)}</span>
                      {referenceOf(purchase.id) ? (
                        <span className="purchase-context" title={purchase.id}>
                          {referenceOf(purchase.id)}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="btn-quiet"
                        disabled={busy}
                        onClick={() => onCorrectSku(purchase.id)}
                        aria-label={`${[
                          formatDate(purchase.purchased_on),
                          purchase.vendor_name ?? "구매처 미기록",
                          formatVolume(
                            purchase.volume_ml ??
                              product.skus.find((sku) => sku.id === purchase.sku_id)?.volume_ml,
                          ),
                          referenceOf(purchase.id),
                        ]
                          .filter(Boolean)
                          .join(" ")} 구매 규격 정정`}
                      >
                        규격 정정
                      </button>
                    </td>
                    <td data-label="구매일">{formatDate(purchase.purchased_on)}</td>
                    <td data-label="구매처">{purchase.vendor_name ?? "미기록"}</td>
                    <td data-label="병수" className="numeric">
                      {purchase.quantity}
                    </td>
                    <td data-label="병당 정가" className="numeric">
                      {formatMoney(purchase.unit_list_price, { short: true })}
                    </td>
                    <td data-label="병당 실구매가" className="numeric">
                      {formatMoney(purchase.unit_paid_price, { short: true })}
                      {purchase.currency !== "KRW" && purchase.foreign_unit_price ? (
                        <span className="muted text-sm foreign-price-note">
                          {purchase.foreign_unit_price} {purchase.currency}
                          {purchase.fx_rate ? ` × ${Number(purchase.fx_rate)}` : ""}
                          {foreignPriceMismatch(purchase) ? " · 원화 실구매가와 다름" : ""}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="총 지출" className="numeric">
                      {formatMoney(purchase.paid_total, { short: true })}
                    </td>
                    {!offline && (
                      <td className="purchase-actions">
                        <div className="button-row">
                          {onUpdatePurchase ? (
                            <button
                              type="button"
                              aria-label="구매 기록 수정"
                              disabled={busy}
                              aria-expanded={editingId === purchase.id}
                              onClick={() => {
                                if (flight.current) return;
                                setEditing({ pending: false, error: null });
                                setEditingId(editingId === purchase.id ? null : purchase.id);
                              }}
                            >
                              수정
                            </button>
                          ) : null}
                          {purchase.quantity > 1 && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setSplittingId(splittingId === purchase.id ? null : purchase.id)
                              }
                            >
                              분할
                            </button>
                          )}
                          <button
                            type="button"
                            className="danger"
                            aria-label="구매 기록 삭제"
                            disabled={busy || deletingPurchaseId === purchase.id}
                            onClick={() =>
                              void confirm({
                                title: "구매 기록 삭제",
                                message:
                                  "이 구매 건과 병을 함께 삭제할까요? 시음 기록이 있는 병이 있으면 삭제되지 않으니 시음 기록을 먼저 정리하세요.",
                                confirmLabel: "삭제",
                                danger: true,
                              }).then((confirmed) => {
                                if (confirmed) onDeletePurchase(purchase.id);
                              })
                            }
                          >
                            {deletingPurchaseId === purchase.id ? "삭제 중…" : "삭제"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {editingId === purchase.id && onUpdatePurchase && (
                    <tr>
                      <td colSpan={8}>
                        <PurchaseEditForm
                          key={purchase.id}
                          purchase={purchase}
                          vendorNames={vendorNames}
                          submitting={editing.pending}
                          error={editing.error}
                          onCancel={() => {
                            if (!flight.current) setEditingId(null);
                          }}
                          onSubmit={(input) => {
                            if (flight.current) return;
                            flight.current = true;
                            onSavingChange(true);
                            const session = captureWriteSession();
                            const draft = captureFormDraft(`purchase-edit:${purchase.id}`);
                            setEditing({ pending: true, error: null });
                            void onUpdatePurchase(purchase.id, { ...input })
                              .then(() => {
                                const cleared = clearSubmittedDraft(draft);
                                if (!mounted.current || !session.isCurrent()) return;
                                setEditing({ pending: false, error: null });
                                if (cleared) setEditingId(null);
                              })
                              .catch((error: unknown) => {
                                if (mounted.current && session.isCurrent())
                                  setEditing({ pending: false, error });
                              })
                              .finally(() => {
                                if (!mounted.current || !session.isCurrent()) return;
                                flight.current = false;
                                onSavingChange(false);
                              });
                          }}
                        />
                      </td>
                    </tr>
                  )}
                  {splittingId === purchase.id && (
                    <tr>
                      <td colSpan={8}>
                        <SplitPurchaseForm
                          totalQuantity={purchase.quantity}
                          submitting={splittingPurchaseId === purchase.id}
                          error={splitError}
                          onSubmit={(parts) => onSplitPurchase(purchase.id, parts)}
                          onCancel={() => setSplittingId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** 구매 추가 폼에 넘긴 새 술 폼의 구매 칸과, 이 술의 작성 중 입력이 없어 실제로 채웠는지. */
interface HandoffPrefill {
  handoff: PurchaseHandoff;
  applied: boolean;
}

/** 구매 추가 폼을 여는 요청. `handoff`는 새 술 폼에서 온 요청에만 있다. */
interface AddPurchaseRequest {
  count: number;
  handoff: PurchaseHandoff | null;
}

/**
 * 넘겨받은 구매 칸으로 이 술의 구매 추가 폼을 채워도 되는지. 사용자가 적은 구매 입력이 있으면
 * 섞지 않는다. 상세 맥락으로 고른 규격(`skuId`)만 남은 초안은 적은 입력이 아니라 지우고
 * 채운다. 남겨 두면 넘긴 용량과 다른 규격이 기본으로 남는다.
 */
function prepareHandoffFill(productId: string): boolean {
  const draft = captureFormDraft(`purchase:${productId}`);
  if (draft.entries.some(([key]) => !key.endsWith(":skuId"))) return false;
  if (draft.entries.length > 0) clearSubmittedDraft(draft);
  return true;
}

function AddPurchaseForm({
  product,
  selectedSkuId,
  prefill,
  onSavingChange,
  onSubmit,
  onAddSku,
  addingSku,
  submitting,
  error,
  vendorNames,
}: {
  product: Product;
  selectedSkuId?: string | undefined;
  prefill: HandoffPrefill | null;
  onSavingChange: (saving: boolean) => void;
  onSubmit: (input: AddPurchaseInput) => void;
  onAddSku: (volumeMl: number) => Promise<Sku>;
  addingSku: boolean;
  submitting: boolean;
  error: unknown;
  vendorNames: string[];
}) {
  const handed = prefill?.applied ? prefill.handoff : null;
  const handedVolume = Number(handed?.volumeMl) > 0 ? Number(handed?.volumeMl) : null;
  // 넘긴 용량이 있으면 그 용량의 규격 하나(`selectedSkuId`)만 고른다. 하나뿐인 다른 용량을
  // 기본으로 고르면 다른 규격에 구매가 붙는다(D273).
  const [skuId, setSkuId] = useDraftState(
    `purchase:${product.id}:skuId`,
    selectedSkuId ??
      (handedVolume === null && product.skus.length === 1 ? (product.skus[0]?.id ?? "") : ""),
  );
  const [quantity, setQuantity] = useDraftState(
    `purchase:${product.id}:quantity`,
    handed?.quantity || "1",
  );
  // 새 술 폼에서 비운 구매처·구매일은 비운 채로 잇는다(그 폼의 기본값도 마지막 구매처·오늘이다).
  const [vendorName, setVendorName] = useDraftState(
    `purchase:${product.id}:vendorName`,
    () => handed?.vendorName ?? getLastVendorName(),
  );
  const [purchasedOn, setPurchasedOn] = useDraftState(
    `purchase:${product.id}:purchasedOn`,
    () => handed?.purchasedOn ?? todayLocal(),
  );
  const [unitListPrice, setUnitListPrice] = useDraftState(
    `purchase:${product.id}:unitListPrice`,
    handed?.unitListPrice ?? "",
  );
  const [unitPaidPrice, setUnitPaidPrice] = useDraftState(
    `purchase:${product.id}:unitPaidPrice`,
    handed?.unitPaidPrice ?? "",
  );
  const missingVolume = handedVolume !== null && handed?.matchingSkus === 0;
  const [newVolumeMl, setNewVolumeMl] = useDraftState(
    `purchase:${product.id}:newVolumeMl`,
    missingVolume ? String(handedVolume) : "",
  );
  // 빈 통화는 원화 구매다.
  const [foreignCurrency, setForeignCurrency] = useDraftState(
    `purchase:${product.id}:foreignCurrency`,
    "",
  );
  const [fxRate, setFxRate] = useDraftState(`purchase:${product.id}:fxRate`, "");
  const [foreignUnitPrice, setForeignUnitPrice] = useDraftState(
    `purchase:${product.id}:foreignUnitPrice`,
    "",
  );
  const foreignPaid = foreignCurrency ? convertedPaidPrice(foreignUnitPrice, fxRate) : null;
  const [localError, setLocalError] = useState<string | null>(null);

  const [confirmedSkus, setConfirmedSkus] = useState<Sku[]>([]);
  const [volumeOpen, setVolumeOpen] = useState(product.skus.length === 0 || missingVolume);
  const [savingSku, setSavingSku] = useState(false);
  const skuFlight = useRef(false);
  const mounted = useRef(true);
  const target = useRef({ productId: product.id, selectedSkuId });
  target.current = { productId: product.id, selectedSkuId };
  const previousContext = useRef<string | undefined>(undefined);
  const skus = [
    ...product.skus,
    ...confirmedSkus.filter((sku) => !product.skus.some((item) => item.id === sku.id)),
  ];
  const chosenSku = skus.find((sku) => sku.id === skuId);
  const busy = submitting || addingSku || savingSku;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setConfirmedSkus((current) => {
      const pending = current.filter((sku) => !product.skus.some((item) => item.id === sku.id));
      return pending.length === current.length ? current : pending;
    });
  }, [product.skus]);
  useEffect(() => {
    if (selectedSkuId && previousContext.current !== selectedSkuId) setSkuId(selectedSkuId);
    previousContext.current = selectedSkuId;
  }, [selectedSkuId, setSkuId]);

  async function addVolume(): Promise<void> {
    if (skuFlight.current || busy) return;
    const volume = Number(newVolumeMl);
    if (!Number.isInteger(volume) || volume < 1 || volume > 100_000) {
      setLocalError("용량은 1~100,000ml 범위의 정수로 입력하세요");
      return;
    }
    const existing = skus.find((sku) => sku.volume_ml === volume);
    if (existing) {
      setSkuId(existing.id);
      setVolumeOpen(false);
      setLocalError(null);
      return;
    }
    const session = captureWriteSession();
    const submittedTarget = target.current;
    skuFlight.current = true;
    setSavingSku(true);
    onSavingChange(true);
    setLocalError(null);
    try {
      session.assertCurrent();
      const sku = await onAddSku(volume);
      if (
        !mounted.current ||
        !session.isCurrent() ||
        target.current.productId !== submittedTarget.productId ||
        target.current.selectedSkuId !== submittedTarget.selectedSkuId
      )
        return;
      if (!sku?.id || sku.volume_ml !== volume)
        throw new Error("추가한 규격을 확인할 수 없습니다. 입력은 보관했습니다");
      setConfirmedSkus((current) => [...current.filter((item) => item.id !== sku.id), sku]);
      setSkuId(sku.id);
      setNewVolumeMl("");
      setVolumeOpen(false);
    } catch (cause) {
      if (
        mounted.current &&
        session.isCurrent() &&
        target.current.productId === submittedTarget.productId &&
        target.current.selectedSkuId === submittedTarget.selectedSkuId
      )
        setLocalError(cause instanceof Error ? cause.message : "규격을 추가하지 못했습니다");
    } finally {
      skuFlight.current = false;
      if (mounted.current && session.isCurrent()) {
        setSavingSku(false);
        onSavingChange(false);
      }
    }
  }

  const vendorSuggestions = useMemo(
    () => rankByQuery(vendorNames, vendorName, (name) => name).slice(0, MAX_SUGGESTIONS),
    [vendorNames, vendorName],
  );

  const errorMessage =
    localError ?? (error instanceof Error ? error.message : error ? String(error) : null);

  return (
    <form
      className="panel"
      aria-label="구매 추가"
      tabIndex={-1}
      onSubmit={(event) => {
        event.preventDefault();
        if (skuFlight.current || busy) return;
        if (!chosenSku) {
          setLocalError("규격을 선택하세요");
          return;
        }
        if (
          !quantity.trim() ||
          !Number.isInteger(Number(quantity)) ||
          Number(quantity) < 1 ||
          Number(quantity) > 1000
        ) {
          setLocalError("병수를 입력하세요");
          return;
        }
        if (foreignCurrency && foreignPaid === null) {
          setLocalError("해외 구매는 외화 단가와 환율을 함께 입력하세요");
          return;
        }
        setLocalError(null);
        onSubmit({
          skuId,
          quantity: Number(quantity),
          vendorName: vendorName.trim(),
          purchasedOn,
          unitListPrice,
          unitPaidPrice: foreignCurrency ? (foreignPaid ?? "") : unitPaidPrice,
          ...(foreignCurrency
            ? { foreign: { currency: foreignCurrency, fxRate, foreignUnitPrice } }
            : {}),
        });
      }}
    >
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <DraftRecoveryButton form={`purchase:${product.id}`} />
        {prefill ? (
          <div className="notice">
            {prefill.applied ? (
              <p>새 술 폼의 구매 입력을 가져왔습니다. 구매를 저장하면 새 술 입력은 지웁니다.</p>
            ) : (
              <p>이 술에 작성 중인 구매 입력이 있어 새 술 폼의 구매 입력은 가져오지 않았습니다.</p>
            )}
            {handedVolume !== null && prefill.handoff.matchingSkus !== 1 ? (
              <p>
                {missingVolume
                  ? `${formatVolume(handedVolume)} 규격이 아직 없습니다. 용량을 추가하거나 다른 규격을 고르세요.`
                  : `${formatVolume(handedVolume)} 규격이 여럿이라 고르지 않았습니다. 규격을 고르세요.`}
              </p>
            ) : null}
          </div>
        ) : null}
        {errorMessage && (
          <p className="alert" role="alert">
            {errorMessage}
          </p>
        )}

        {skuId && !chosenSku ? (
          <p className="alert" role="alert">
            선택한 규격을 사용할 수 없습니다. 입력을 보관했습니다. 사용할 규격을 직접 선택하세요.
          </p>
        ) : null}
        {skus.length === 0 ? (
          <p className="muted">
            이 술은 아직 규격(용량)이 없습니다. 구매를 추가하려면 먼저 규격을 등록하세요.
          </p>
        ) : null}
        {skus.length > 1 || !chosenSku ? (
          <div className="field">
            <label htmlFor="purchase-sku">규격</label>
            <select
              id="purchase-sku"
              value={skuId}
              onChange={(event) => {
                setSkuId(event.target.value);
                setLocalError(null);
              }}
            >
              <option value="">규격을 선택하세요</option>
              {skuId && !chosenSku ? <option value={skuId}>사용할 수 없는 이전 규격</option> : null}
              {skus.map((sku) => (
                <option key={sku.id} value={sku.id}>
                  {formatVolume(sku.volume_ml)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="muted">선택 규격: {formatVolume(chosenSku?.volume_ml)}</p>
        )}
        {!volumeOpen && skus.length > 0 ? (
          <button type="button" onClick={() => setVolumeOpen(true)}>
            다른 용량 추가
          </button>
        ) : null}
        {volumeOpen || skus.length === 0 ? (
          <fieldset className="fieldset-bordered">
            <legend>{skus.length ? "다른 용량 추가" : "첫 규격 추가"}</legend>
            <label htmlFor="new-sku-volume">용량 (ml)</label>
            <input
              id="new-sku-volume"
              type="number"
              inputMode="numeric"
              min={1}
              max={100000}
              step={1}
              value={newVolumeMl}
              onChange={(event) => setNewVolumeMl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addVolume();
                }
              }}
            />
            <div className="button-row">
              <button type="button" onClick={() => void addVolume()} disabled={busy}>
                {savingSku || addingSku ? "추가 중…" : "규격 추가"}
              </button>
              {skus.length > 0 ? (
                <button type="button" onClick={() => setVolumeOpen(false)}>
                  용량 추가 취소
                </button>
              ) : null}
            </div>
          </fieldset>
        ) : null}

        <div className="field-row">
          <div className="field">
            <label htmlFor="purchase-quantity">병수</label>
            <input
              id="purchase-quantity"
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="purchase-date">구매일</label>
            <input
              id="purchase-date"
              type="date"
              value={purchasedOn}
              onChange={(event) => setPurchasedOn(event.target.value)}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="purchase-list-price">병당 정가 (원)</label>
            <input
              id="purchase-list-price"
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={unitListPrice}
              onChange={(event) => setUnitListPrice(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="purchase-paid-price">병당 실구매가 (원)</label>
            <input
              id="purchase-paid-price"
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={foreignCurrency ? (foreignPaid ?? "") : unitPaidPrice}
              readOnly={Boolean(foreignCurrency)}
              aria-describedby={foreignCurrency ? "purchase-foreign-note" : undefined}
              onChange={(event) => setUnitPaidPrice(event.target.value)}
            />
          </div>
        </div>

        <div className="checkbox-field">
          <label>
            <input
              type="checkbox"
              checked={Boolean(foreignCurrency)}
              onChange={(event) => setForeignCurrency(event.target.checked ? "USD" : "")}
            />
            해외 구매(외화로 결제)
          </label>
        </div>
        {foreignCurrency ? (
          <fieldset className="fieldset-bordered">
            <legend>외화 결제</legend>
            <div className="field-row">
              <div className="field">
                <label htmlFor="purchase-currency">통화</label>
                <select
                  id="purchase-currency"
                  value={foreignCurrency}
                  onChange={(event) => setForeignCurrency(event.target.value)}
                >
                  {FOREIGN_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="purchase-foreign-price">병당 외화 단가 ({foreignCurrency})</label>
                <input
                  id="purchase-foreign-price"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  value={foreignUnitPrice}
                  onChange={(event) => setForeignUnitPrice(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="purchase-fx-rate">환율 (1 {foreignCurrency}당 원)</label>
                <input
                  id="purchase-fx-rate"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  value={fxRate}
                  onChange={(event) => setFxRate(event.target.value)}
                />
              </div>
            </div>
            <p id="purchase-foreign-note" className="muted text-sm mb-0">
              실구매가는 외화 단가 × 환율을 원 단위로 반올림해 저장합니다. 카드 청구액 기준으로
              맞추려면 청구 원화 ÷ 외화 단가를 환율로 넣으세요.
            </p>
          </fieldset>
        ) : null}

        <div className="field">
          <label htmlFor="purchase-vendor">구매처</label>
          <AutocompleteInput
            id="purchase-vendor"
            value={vendorName}
            placeholder="없으면 비워 두세요"
            onChange={setVendorName}
            suggestions={vendorSuggestions}
          />
        </div>

        <button type="submit" className="primary" disabled={busy || !chosenSku}>
          {submitting ? "저장 중…" : "구매 저장"}
        </button>
      </fieldset>
    </form>
  );
}

function SplitPurchaseForm({
  totalQuantity,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  totalQuantity: number;
  submitting: boolean;
  error: unknown;
  onSubmit: (parts: SplitPart[]) => void;
  onCancel: () => void;
}) {
  // React 목록 key 용 안정적인 로컬 id — SplitPart 자체(quantity/vendorName)에는 없다.
  // 서버로 보낼 때는 벗겨 낸다.
  const [parts, setParts] = useState<(SplitPart & { key: string })[]>(() => [
    { key: crypto.randomUUID(), quantity: "1", vendorName: "" },
    {
      key: crypto.randomUUID(),
      quantity: String(Math.max(1, totalQuantity - 1)),
      vendorName: "",
    },
  ]);
  const [localError, setLocalError] = useState<string | null>(null);

  const errorMessage =
    localError ?? (error instanceof Error ? error.message : error ? String(error) : null);

  function updatePart(index: number, patch: Partial<SplitPart>) {
    setParts((prev) => prev.map((part, i) => (i === index ? { ...part, ...patch } : part)));
  }

  return (
    <form
      className="panel"
      aria-label="구매 건 분할"
      onSubmit={(event) => {
        event.preventDefault();
        const sum = parts.reduce((acc, part) => acc + (Number(part.quantity) || 0), 0);
        if (sum !== totalQuantity) {
          setLocalError(`병수 합이 원래 구매 병수(${totalQuantity}병)와 같아야 합니다`);
          return;
        }
        setLocalError(null);
        onSubmit(parts.map(({ quantity, vendorName }) => ({ quantity, vendorName })));
      }}
    >
      <p className="muted text-sm mt-0">
        구매처별로 나눠 받은 경우처럼, 한 구매 건을 여러 건으로 쪼갭니다. 병수 합이 원래 병수(
        {totalQuantity}병)와 같아야 합니다.
      </p>
      {errorMessage && (
        <p className="alert" role="alert">
          {errorMessage}
        </p>
      )}
      {parts.map((part, index) => (
        <div className="field-row" key={part.key}>
          <div className="field">
            <label htmlFor={`split-quantity-${index}`}>병수</label>
            <input
              id={`split-quantity-${index}`}
              type="number"
              inputMode="numeric"
              min={1}
              value={part.quantity}
              onChange={(event) => updatePart(index, { quantity: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`split-vendor-${index}`}>구매처</label>
            <input
              id={`split-vendor-${index}`}
              value={part.vendorName}
              placeholder="없으면 비워 두세요"
              onChange={(event) => updatePart(index, { vendorName: event.target.value })}
            />
          </div>
        </div>
      ))}
      <div className="button-row">
        <button
          type="button"
          onClick={() =>
            setParts((prev) => [
              ...prev,
              { key: crypto.randomUUID(), quantity: "1", vendorName: "" },
            ])
          }
        >
          나눌 부분 추가
        </button>
      </div>
      <div className="button-row mt-3">
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? "분할 중…" : "분할 실행"}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          취소
        </button>
      </div>
    </form>
  );
}

// --- 병 ---------------------------------------------------------------------
