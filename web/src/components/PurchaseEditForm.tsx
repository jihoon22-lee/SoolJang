/**
 * 구매 건 수정 — 구매일·구매처·가격·병수·외화 결제.
 *
 * 이전에는 수정 경로가 없어 가격 오타 하나를 고치려면 구매를 지우고 다시 만들어야 했다.
 * 그러면 딸린 병의 개봉·소진 상태와 시음 연결까지 사라진다. 병수를 줄이면 번호가 큰
 * 미개봉 병부터 지우며, 이미 마신 병은 서버가 지우지 않는다.
 *
 * 외화 구매는 등록 폼처럼 실구매가를 외화 단가 × 환율의 원 단위 값으로 둔다(D276). 외화 칸을
 * 고치지 않으면 실구매가와 외화 값을 보내지 않아, 검사 전에 어긋난 기록도 구매처 같은 다른
 * 칸은 그대로 고칠 수 있다.
 */

import { useId, useRef, useState } from "react";
import { purchasesApi } from "@/api/client";
import type { Purchase } from "@/api/types";
import { AutocompleteInput } from "@/components/AutocompleteInput";
import { HistoryDetails } from "@/components/HistoryList";
import {
  convertedPaidPrice,
  FOREIGN_CURRENCIES,
  FOREIGN_PRICE_MESSAGES,
  foreignPriceMismatch,
  foreignPriceProblem,
  sameAmount,
} from "@/domain/purchaseFx";
import { rankByQuery } from "@/search";
import { useDraftState } from "@/sync/drafts";

export interface EditPurchaseInput {
  purchasedOn: string;
  vendorName: string;
  quantity: number;
  unitListPrice: string;
  /** 외화 칸을 고치지 않은 외화 구매는 없다(저장된 실구매가를 그대로 둔다). */
  unitPaidPrice?: string;
  /** 외화 칸을 고쳤을 때만 있다. null 은 원화 구매로 되돌린다. */
  foreign?: { currency: string; fxRate: string; foreignUnitPrice: string } | null;
}

const MAX_SUGGESTIONS = 8;

function priceInput(value: string | null): string {
  if (value === null) return "";
  const amount = Number(value);
  return Number.isFinite(amount) && amount !== 0 ? String(Math.round(amount * 100) / 100) : "";
}

/** 저장 형식("1431.900000")을 입력 칸 값("1431.9")으로 바꾼다. */
function decimalInput(value: string | null): string {
  if (value === null) return "";
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

export function PurchaseEditForm({
  purchase,
  vendorNames,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  purchase: Purchase;
  vendorNames: string[];
  submitting: boolean;
  error: unknown;
  onSubmit: (input: EditPurchaseInput) => void;
  onCancel: () => void;
}) {
  const [purchasedOn, setPurchasedOn] = useDraftState(
    `purchase-edit:${purchase.id}:purchasedOn`,
    purchase.purchased_on ?? "",
  );
  const [vendorName, setVendorName] = useDraftState(
    `purchase-edit:${purchase.id}:vendorName`,
    purchase.vendor_name ?? "",
  );
  const [quantity, setQuantity] = useDraftState(
    `purchase-edit:${purchase.id}:quantity`,
    String(purchase.quantity),
  );
  const [unitListPrice, setUnitListPrice] = useDraftState(
    `purchase-edit:${purchase.id}:unitListPrice`,
    priceInput(purchase.unit_list_price),
  );
  const [unitPaidPrice, setUnitPaidPrice] = useDraftState(
    `purchase-edit:${purchase.id}:unitPaidPrice`,
    priceInput(purchase.unit_paid_price),
  );
  // 빈 통화는 원화 구매다(구매 추가 폼과 같음).
  const storedCurrency = purchase.currency === "KRW" ? "" : purchase.currency;
  const storedRate = decimalInput(purchase.fx_rate);
  const storedForeignPrice = decimalInput(purchase.foreign_unit_price);
  const [foreignCurrency, setForeignCurrency] = useDraftState(
    `purchase-edit:${purchase.id}:foreignCurrency`,
    storedCurrency,
  );
  const [fxRate, setFxRate] = useDraftState(`purchase-edit:${purchase.id}:fxRate`, storedRate);
  const [foreignUnitPrice, setForeignUnitPrice] = useDraftState(
    `purchase-edit:${purchase.id}:foreignUnitPrice`,
    storedForeignPrice,
  );
  // 외화 값은 그대로 두고 어긋난 실구매가만 환산값으로 맞출 때.
  const [recompute, setRecompute] = useState(false);
  const paidRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const ids = {
    date: useId(),
    qty: useId(),
    list: useId(),
    paid: useId(),
    vendor: useId(),
    currency: useId(),
    foreignPrice: useId(),
    rate: useId(),
    note: useId(),
  };
  const currencies = [...new Set([storedCurrency, ...FOREIGN_CURRENCIES].filter(Boolean))];
  const foreignEdited =
    recompute ||
    foreignCurrency !== storedCurrency ||
    !sameAmount(fxRate, storedRate) ||
    !sameAmount(foreignUnitPrice, storedForeignPrice);
  const convertedPaid = foreignCurrency ? convertedPaidPrice(foreignUnitPrice, fxRate) : null;
  const storedMismatch =
    Boolean(storedCurrency) && !foreignEdited && foreignPriceMismatch(purchase);

  const quantityValue = Number(quantity);
  const quantityValid =
    Number.isInteger(quantityValue) && quantityValue > 0 && quantityValue <= 1000;
  const shrinking = quantityValid && quantityValue < purchase.quantity;
  const suggestions = rankByQuery(vendorNames, vendorName, (name) => name).slice(
    0,
    MAX_SUGGESTIONS,
  );
  const message =
    localError ?? (error instanceof Error ? error.message : error ? String(error) : null);

  return (
    <form
      className="sheet"
      aria-label="구매 건 수정"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting || !quantityValid) return;
        const base = {
          purchasedOn,
          vendorName: vendorName.trim(),
          quantity: quantityValue,
          unitListPrice: unitListPrice.trim(),
        };
        if (!foreignCurrency) {
          setLocalError(null);
          onSubmit({
            ...base,
            unitPaidPrice: unitPaidPrice.trim(),
            ...(storedCurrency ? { foreign: null } : {}),
          });
          return;
        }
        if (!foreignEdited) {
          setLocalError(null);
          onSubmit(base);
          return;
        }
        if (convertedPaid === null) {
          setLocalError("해외 구매는 외화 단가와 환율을 함께 입력하세요");
          return;
        }
        const problem = foreignPriceProblem({
          currency: foreignCurrency,
          fxRate,
          foreignUnitPrice,
          unitPaidPrice: convertedPaid,
        });
        if (problem) {
          setLocalError(FOREIGN_PRICE_MESSAGES[problem]);
          return;
        }
        setLocalError(null);
        onSubmit({
          ...base,
          unitPaidPrice: convertedPaid,
          foreign: {
            currency: foreignCurrency,
            fxRate: fxRate.trim(),
            foreignUnitPrice: foreignUnitPrice.trim(),
          },
        });
      }}
    >
      <fieldset disabled={submitting} style={{ border: 0, padding: 0 }}>
        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.date}>구매일</label>
            <input
              id={ids.date}
              type="date"
              value={purchasedOn}
              onChange={(event) => setPurchasedOn(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.qty}>병수</label>
            <input
              id={ids.qty}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              required
              aria-invalid={!quantityValid}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor={ids.list}>병당 정가 (원)</label>
            <input
              id={ids.list}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="비우면 0원"
              value={unitListPrice}
              onChange={(event) => setUnitListPrice(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.paid}>병당 실구매가 (원)</label>
            <input
              ref={paidRef}
              id={ids.paid}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder={foreignCurrency ? undefined : "비우면 0원(선물·포인트)"}
              value={
                !foreignCurrency
                  ? unitPaidPrice
                  : foreignEdited
                    ? (convertedPaid ?? "")
                    : priceInput(purchase.unit_paid_price)
              }
              readOnly={Boolean(foreignCurrency)}
              aria-describedby={foreignCurrency ? ids.note : undefined}
              onChange={(event) => setUnitPaidPrice(event.target.value)}
            />
          </div>
        </div>
        <div className="checkbox-field">
          <label>
            <input
              type="checkbox"
              checked={Boolean(foreignCurrency)}
              onChange={(event) =>
                setForeignCurrency(event.target.checked ? storedCurrency || "USD" : "")
              }
            />
            해외 구매(외화로 결제)
          </label>
        </div>
        {foreignCurrency ? (
          <fieldset className="fieldset-bordered">
            <legend>외화 결제</legend>
            <div className="field-row">
              <div className="field">
                <label htmlFor={ids.currency}>통화</label>
                <select
                  id={ids.currency}
                  value={foreignCurrency}
                  onChange={(event) => setForeignCurrency(event.target.value)}
                >
                  {currencies.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={ids.foreignPrice}>병당 외화 단가 ({foreignCurrency})</label>
                <input
                  id={ids.foreignPrice}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  value={foreignUnitPrice}
                  onChange={(event) => setForeignUnitPrice(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={ids.rate}>환율 (1 {foreignCurrency}당 원)</label>
                <input
                  id={ids.rate}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  value={fxRate}
                  onChange={(event) => setFxRate(event.target.value)}
                />
              </div>
            </div>
            <p id={ids.note} className="muted text-sm mb-0">
              {storedMismatch
                ? "저장된 실구매가가 외화 단가 × 환율과 1% 넘게 다릅니다. 외화 칸을 고치거나 환산값으로 맞추면 외화 단가 × 환율을 원 단위로 반올림해 저장합니다."
                : "실구매가는 외화 단가 × 환율을 원 단위로 반올림해 저장합니다."}
            </p>
            {storedMismatch ? (
              <button
                type="button"
                className="btn-quiet"
                onClick={() => {
                  setRecompute(true);
                  // 누른 단추가 사라지므로 바뀐 실구매가로 초점을 옮긴다.
                  paidRef.current?.focus();
                }}
              >
                환산값으로 맞추기
              </button>
            ) : null}
          </fieldset>
        ) : null}
        <div className="field">
          <label htmlFor={ids.vendor}>구매처</label>
          <AutocompleteInput
            id={ids.vendor}
            value={vendorName}
            placeholder="없으면 비워 두세요"
            onChange={setVendorName}
            suggestions={suggestions}
          />
        </div>
        {shrinking ? (
          <p className="muted text-sm">
            병수를 줄이면 번호가 큰 미개봉 병부터 지웁니다. 이미 개봉·소진한 병은 지우지 않습니다.
          </p>
        ) : null}
        {message ? (
          <p className="alert" role="alert">
            {message}
          </p>
        ) : null}
        <HistoryDetails
          title="이 구매의 수정 이력"
          queryKey={["purchases", purchase.id, "history"]}
          load={(signal) => purchasesApi.history(purchase.id, signal)}
          online
        />
        <div className="button-row">
          <button type="submit" className="primary" disabled={submitting || !quantityValid}>
            {submitting ? "저장 중…" : "수정 저장"}
          </button>
          <button type="button" disabled={submitting} onClick={onCancel}>
            취소
          </button>
        </div>
      </fieldset>
    </form>
  );
}
