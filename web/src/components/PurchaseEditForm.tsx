/**
 * 구매 건 수정 — 구매일·구매처·가격·병수.
 *
 * 이전에는 수정 경로가 없어 가격 오타 하나를 고치려면 구매를 지우고 다시 만들어야 했다.
 * 그러면 딸린 병의 개봉·소진 상태와 시음 연결까지 사라진다. 병수를 줄이면 번호가 큰
 * 미개봉 병부터 지우며, 이미 마신 병은 서버가 지우지 않는다.
 */

import { useId, useState } from "react";
import type { Purchase } from "@/api/types";
import { AutocompleteInput } from "@/components/AutocompleteInput";
import { rankByQuery } from "@/search";

export interface EditPurchaseInput {
  purchasedOn: string;
  vendorName: string;
  quantity: number;
  unitListPrice: string;
  unitPaidPrice: string;
}

const MAX_SUGGESTIONS = 8;

function priceInput(value: string | null): string {
  if (value === null) return "";
  const amount = Number(value);
  return Number.isFinite(amount) && amount !== 0 ? String(Math.round(amount * 100) / 100) : "";
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
  const [purchasedOn, setPurchasedOn] = useState(purchase.purchased_on ?? "");
  const [vendorName, setVendorName] = useState(purchase.vendor_name ?? "");
  const [quantity, setQuantity] = useState(String(purchase.quantity));
  const [unitListPrice, setUnitListPrice] = useState(priceInput(purchase.unit_list_price));
  const [unitPaidPrice, setUnitPaidPrice] = useState(priceInput(purchase.unit_paid_price));
  const ids = { date: useId(), qty: useId(), list: useId(), paid: useId(), vendor: useId() };

  const quantityValue = Number(quantity);
  const quantityValid =
    Number.isInteger(quantityValue) && quantityValue > 0 && quantityValue <= 1000;
  const shrinking = quantityValid && quantityValue < purchase.quantity;
  const suggestions = rankByQuery(vendorNames, vendorName, (name) => name).slice(
    0,
    MAX_SUGGESTIONS,
  );
  const message = error instanceof Error ? error.message : error ? String(error) : null;

  return (
    <form
      className="sheet"
      aria-label="구매 건 수정"
      onSubmit={(event) => {
        event.preventDefault();
        if (!quantityValid) return;
        onSubmit({
          purchasedOn,
          vendorName: vendorName.trim(),
          quantity: quantityValue,
          unitListPrice: unitListPrice.trim(),
          unitPaidPrice: unitPaidPrice.trim(),
        });
      }}
    >
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
            id={ids.paid}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="비우면 0원(선물·포인트)"
            value={unitPaidPrice}
            onChange={(event) => setUnitPaidPrice(event.target.value)}
          />
        </div>
      </div>
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
      <div className="button-row">
        <button type="submit" className="primary" disabled={submitting || !quantityValid}>
          {submitting ? "저장 중…" : "수정 저장"}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
