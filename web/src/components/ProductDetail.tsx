import { Fragment, useMemo, useState } from "react";
import type { Bottle, BottleStatus, Product, Purchase } from "@/api/types";
import { AutocompleteInput } from "@/components/AutocompleteInput";
import { BottlePanel, formatRemaining, STATUS_LABELS } from "@/components/BottlePanel";
import {
  formatAbv,
  formatCategoryPath,
  formatDate,
  formatMoney,
  formatPercent,
  formatRating,
  formatVolume,
} from "@/format";
import { getLastVendorName } from "@/lastVendor";
import { rankByQuery } from "@/search";

//: `ProductForm` 과 같은 값 — 405종 목록에서도 스크롤 없이 훑을 수 있는 후보 수.
const MAX_SUGGESTIONS = 8;

export interface AddPurchaseInput {
  skuId: string;
  quantity: number;
  vendorName: string;
  purchasedOn: string;
  unitListPrice: string;
  unitPaidPrice: string;
}

export interface SplitPart {
  quantity: string;
  vendorName: string;
}

interface ProductDetailProps {
  product: Product;
  purchases: Purchase[];
  bottles: Bottle[];
  offline: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;

  onAddPurchase: (input: AddPurchaseInput) => void;
  addingPurchase: boolean;
  addPurchaseError: unknown;
  /** 구매 추가 폼의 구매처 자동완성 후보. */
  vendorNames: string[];

  onDeletePurchase: (purchaseId: string) => void;
  deletingPurchaseId: string | null;

  onSplitPurchase: (purchaseId: string, parts: SplitPart[]) => void;
  splittingPurchaseId: string | null;
  splitError: unknown;

  onAddSku: (volumeMl: number) => void;
  addingSku: boolean;
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
export function ProductDetail({
  product,
  purchases,
  bottles,
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
  onSplitPurchase,
  splittingPurchaseId,
  splitError,
  onAddSku,
  addingSku,
}: ProductDetailProps) {
  const { metrics } = product;

  return (
    <article aria-labelledby="detail-heading">
      <div className="button-row mb-3">
        <button type="button" onClick={onBack}>
          ← 목록으로
        </button>
        <button type="button" onClick={onEdit}>
          수정
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? "삭제 중…" : "삭제"}
        </button>
      </div>

      <div className="panel">
        <h2 id="detail-heading" className="mb-1">
          {product.name}
          {product.vintage !== null && <span className="muted"> ({product.vintage})</span>}
        </h2>
        <p className="muted mt-0">
          {formatCategoryPath(product.category_path)}
          {product.producer_name && ` · ${product.producer_name}`}
          {product.country && ` · ${product.country}`}
        </p>

        <dl className="product-card-dl">
          <div>
            <dt className="muted">도수</dt>
            <dd>{formatAbv(product.abv)}</dd>
          </div>
          <div>
            <dt className="muted">규격</dt>
            <dd>
              {product.skus.length === 0
                ? "등록된 규격 없음"
                : product.skus.map((sku) => formatVolume(sku.volume_ml)).join(", ")}
            </dd>
          </div>
          <div>
            <dt className="muted">품종·스타일</dt>
            <dd>{product.varieties.length === 0 ? "—" : product.varieties.join(", ")}</dd>
          </div>
          <div>
            <dt className="muted">내 평점</dt>
            <dd>{formatRating(product.personal_rating)}</dd>
          </div>
        </dl>

        {product.note && <p className="pre-wrap">{product.note}</p>}
      </div>

      <h3>파생 지표</h3>
      <p className="muted text-sm mt-0">
        모두 구매 기록에서 자동 계산됩니다. 직접 입력하거나 수정할 필요가 없습니다.
      </p>
      <dl className="metrics-grid">
        <Metric label="구매 병수" value={`${metrics.purchased_count}병`} />
        <Metric label="재고 병수" value={`${metrics.in_stock_count}병`} />
        <Metric
          label="미개봉 / 개봉"
          value={`${metrics.unopened_count} / ${metrics.opened_count}병`}
        />
        <Metric label="소진 병수" value={`${metrics.consumed_count}병`} />
        <Metric label="평단가" value={formatMoney(metrics.avg_list_price)} />
        <Metric label="실평단가" value={formatMoney(metrics.avg_paid_price)} />
        <Metric
          label="100ml당 가격"
          value={formatMoney(metrics.price_per_100ml)}
          hint="정가 기준"
        />
        <Metric label="할인율" value={formatPercent(metrics.discount_rate)} />
        <Metric label="총 지출" value={formatMoney(metrics.paid_total)} />
        <Metric
          label="재고 자산가치"
          value={formatMoney(metrics.inventory_value_at_cost)}
          hint="실평단가 기준"
        />
      </dl>

      <PurchaseSection
        product={product}
        purchases={purchases}
        offline={offline}
        onAddPurchase={onAddPurchase}
        addingPurchase={addingPurchase}
        addPurchaseError={addPurchaseError}
        vendorNames={vendorNames}
        onDeletePurchase={onDeletePurchase}
        deletingPurchaseId={deletingPurchaseId}
        onSplitPurchase={onSplitPurchase}
        splittingPurchaseId={splittingPurchaseId}
        splitError={splitError}
        onAddSku={onAddSku}
        addingSku={addingSku}
      />

      <BottleSection bottles={bottles} offline={offline} />
    </article>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
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
  purchases,
  offline,
  onAddPurchase,
  addingPurchase,
  addPurchaseError,
  vendorNames,
  onDeletePurchase,
  deletingPurchaseId,
  onSplitPurchase,
  splittingPurchaseId,
  splitError,
  onAddSku,
  addingSku,
}: {
  product: Product;
  purchases: Purchase[];
  offline: boolean;
  onAddPurchase: (input: AddPurchaseInput) => void;
  addingPurchase: boolean;
  addPurchaseError: unknown;
  vendorNames: string[];
  onDeletePurchase: (purchaseId: string) => void;
  deletingPurchaseId: string | null;
  onSplitPurchase: (purchaseId: string, parts: SplitPart[]) => void;
  splittingPurchaseId: string | null;
  splitError: unknown;
  onAddSku: (volumeMl: number) => void;
  addingSku: boolean;
}) {
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [splittingId, setSplittingId] = useState<string | null>(null);

  return (
    <>
      <div className="section-header">
        <h3>구매 이력</h3>
        {!offline && (
          <button type="button" onClick={() => setAddFormOpen((open) => !open)}>
            {addFormOpen ? "취소" : "구매 추가"}
          </button>
        )}
      </div>
      {offline && (
        <p className="muted text-sm">구매 추가·삭제·분할은 온라인일 때만 할 수 있습니다.</p>
      )}

      {addFormOpen && (
        <AddPurchaseForm
          product={product}
          onSubmit={(input) => {
            onAddPurchase(input);
          }}
          onAddSku={onAddSku}
          addingSku={addingSku}
          submitting={addingPurchase}
          error={addPurchaseError}
          vendorNames={vendorNames}
        />
      )}

      {purchases.length === 0 ? (
        <output className="notice">
          구매 기록이 없습니다. 같은 술을 여러 번 샀다면 구매 건을 각각 추가해 구매처와 가격을 따로
          남길 수 있습니다.
        </output>
      ) : (
        <div className="table-scroll table-scroll--always">
          <table className="product-table">
            <caption className="sr-only">구매 이력</caption>
            <thead>
              <tr>
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
              {purchases.map((purchase) => (
                <Fragment key={purchase.id}>
                  <tr>
                    <td>{formatDate(purchase.purchased_on)}</td>
                    <td>{purchase.vendor_name ?? "미기록"}</td>
                    <td className="numeric">{purchase.quantity}</td>
                    <td className="numeric">
                      {formatMoney(purchase.unit_list_price, { short: true })}
                    </td>
                    <td className="numeric">
                      {formatMoney(purchase.unit_paid_price, { short: true })}
                    </td>
                    <td className="numeric">{formatMoney(purchase.paid_total, { short: true })}</td>
                    {!offline && (
                      <td>
                        <div className="button-row">
                          {purchase.quantity > 1 && (
                            <button
                              type="button"
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
                            disabled={deletingPurchaseId === purchase.id}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "이 구매 건을 삭제할까요? 연결된 병 기록도 함께 사라집니다.",
                                )
                              ) {
                                onDeletePurchase(purchase.id);
                              }
                            }}
                          >
                            {deletingPurchaseId === purchase.id ? "삭제 중…" : "삭제"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {splittingId === purchase.id && (
                    <tr>
                      <td colSpan={7}>
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
    </>
  );
}

function AddPurchaseForm({
  product,
  onSubmit,
  onAddSku,
  addingSku,
  submitting,
  error,
  vendorNames,
}: {
  product: Product;
  onSubmit: (input: AddPurchaseInput) => void;
  onAddSku: (volumeMl: number) => void;
  addingSku: boolean;
  submitting: boolean;
  error: unknown;
  vendorNames: string[];
}) {
  const [skuId, setSkuId] = useState(product.skus[0]?.id ?? "");
  const [quantity, setQuantity] = useState("1");
  const [vendorName, setVendorName] = useState(() => getLastVendorName());
  const [purchasedOn, setPurchasedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [unitListPrice, setUnitListPrice] = useState("");
  const [unitPaidPrice, setUnitPaidPrice] = useState("");
  const [newVolumeMl, setNewVolumeMl] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const vendorSuggestions = useMemo(
    () => rankByQuery(vendorNames, vendorName, (name) => name).slice(0, MAX_SUGGESTIONS),
    [vendorNames, vendorName],
  );

  const errorMessage =
    localError ?? (error instanceof Error ? error.message : error ? String(error) : null);

  if (product.skus.length === 0) {
    return (
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newVolumeMl.trim()) return;
          onAddSku(Number(newVolumeMl));
        }}
      >
        <p className="muted mt-0">
          이 술은 아직 규격(용량)이 없습니다. 구매를 추가하려면 먼저 규격을 등록하세요.
        </p>
        <div className="field">
          <label htmlFor="new-sku-volume">용량 (ml)</label>
          <input
            id="new-sku-volume"
            type="number"
            min={1}
            value={newVolumeMl}
            onChange={(event) => setNewVolumeMl(event.target.value)}
          />
        </div>
        <button type="submit" className="primary" disabled={addingSku}>
          {addingSku ? "추가 중…" : "규격 추가"}
        </button>
      </form>
    );
  }

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!skuId) {
          setLocalError("규격을 선택하세요");
          return;
        }
        if (!quantity.trim() || Number(quantity) < 1) {
          setLocalError("병수를 입력하세요");
          return;
        }
        setLocalError(null);
        onSubmit({
          skuId,
          quantity: Number(quantity),
          vendorName: vendorName.trim(),
          purchasedOn,
          unitListPrice,
          unitPaidPrice,
        });
      }}
    >
      {errorMessage && (
        <p className="alert" role="alert">
          {errorMessage}
        </p>
      )}

      {product.skus.length > 1 && (
        <div className="field">
          <label htmlFor="purchase-sku">규격</label>
          <select
            id="purchase-sku"
            value={skuId}
            onChange={(event) => setSkuId(event.target.value)}
          >
            {product.skus.map((sku) => (
              <option key={sku.id} value={sku.id}>
                {formatVolume(sku.volume_ml)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor="purchase-quantity">병수</label>
          <input
            id="purchase-quantity"
            type="number"
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
            min={0}
            value={unitPaidPrice}
            onChange={(event) => setUnitPaidPrice(event.target.value)}
          />
        </div>
      </div>

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

      <button type="submit" className="primary" disabled={submitting}>
        {submitting ? "저장 중…" : "구매 추가"}
      </button>
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

const IN_STOCK_STATUSES: readonly BottleStatus[] = ["unopened", "open"];

function BottleSection({ bottles, offline }: { bottles: Bottle[]; offline: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (bottles.length === 0) {
    return (
      <>
        <h3>병</h3>
        <output className="notice">
          등록된 병이 없습니다. 구매 건을 추가하면 병이 자동으로 만들어집니다.
        </output>
      </>
    );
  }

  // 재고(미개봉·개봉)를 먼저, 소진·증여·판매는 아래로 — "지금 마실 수 있는 게 뭔지"가
  // 더 자주 찾는 정보다.
  const sorted = [...bottles].sort((a, b) => {
    const rankOf = (status: BottleStatus) => (IN_STOCK_STATUSES.includes(status) ? 0 : 1);
    const rankDiff = rankOf(a.status) - rankOf(b.status);
    return rankDiff !== 0 ? rankDiff : a.label_no - b.label_no;
  });

  return (
    <>
      <h3>병 ({bottles.length}개)</h3>
      <ul className="bottle-list">
        {sorted.map((bottle) => (
          <li key={bottle.id}>
            <button
              type="button"
              className="bottle-list-item"
              aria-expanded={expandedId === bottle.id}
              onClick={() => setExpandedId(expandedId === bottle.id ? null : bottle.id)}
            >
              <span className="bottle-list-label">{bottle.label_no}번 병</span>
              <span className={`bottle-badge bottle-badge-${bottle.status}`}>
                {STATUS_LABELS[bottle.status]}
              </span>
              <span className="bottle-list-remaining">{formatRemaining(bottle)}</span>
            </button>
            {expandedId === bottle.id ? <BottlePanel bottle={bottle} offline={offline} /> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
