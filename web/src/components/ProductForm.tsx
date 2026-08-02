import { useState } from "react";
import { ApiError } from "@/api/client";
import type { CategoryNode } from "@/api/types";
import { formatCategoryPath } from "@/format";

export interface ProductFormValues {
  name: string;
  categoryId: string;
  abv: string;
  vintage: string;
  volumeMl: string;
  varietyNames: string;
  personalRating: string;
  note: string;
  /** 구매 정보. 비워 두면 구매 건을 만들지 않는다. */
  quantity: string;
  unitListPrice: string;
  unitPaidPrice: string;
  purchasedOn: string;
  vendorName: string;
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  name: "",
  categoryId: "",
  abv: "",
  vintage: "",
  volumeMl: "",
  varietyNames: "",
  personalRating: "",
  note: "",
  quantity: "",
  unitListPrice: "",
  unitPaidPrice: "",
  purchasedOn: "",
  vendorName: "",
};

interface ProductFormProps {
  categories: CategoryNode[];
  submitting: boolean;
  error: unknown;
  onSubmit: (values: ProductFormValues) => void;
  onCancel: () => void;
  /** 라벨 OCR(Task 17) 등이 미리 채운 값. 마운트 시점에만 반영된다 — 폼이 열린 뒤 값이
   * 바뀌어도 다시 채우지 않는다(사용자가 이미 고친 입력을 덮어쓰지 않기 위해서다). */
  initialValues?: Partial<ProductFormValues> | undefined;
  /** `"edit"` 이면 구매 정보(용량 포함) 입력을 숨긴다 — 용량은 SKU 필드라
   * `PATCH /products/{id}` 범위 밖이고(바코드 스캔에서 별도로 다룬다), 구매 건은
   * 이 폼이 아니라 제품 상세의 "구매 이력"에서 추가한다. 기본값은 `"create"`. */
  mode?: "create" | "edit";
}

/**
 * 제품 등록·수정 폼.
 *
 * 등록(`create`)은 제품·규격·구매 건을 **한 폼에서** 만든다. 4계층 구조는 기록 정확성을
 * 위해 필요하지만, 입력할 때마다 세 화면을 거치게 하면 기록 자체를 안 하게 된다. 구매
 * 정보는 선택이며 비워 두면 제품만 만든다.
 *
 * 수정(`edit`)은 이미 존재하는 제품의 이름·주종·도수·빈티지·평점·품종·메모만 고친다 —
 * 새 컴포넌트를 만들지 않고 이 폼을 재사용한다(두 모드가 대부분의 필드를 공유한다).
 */
export function ProductForm({
  categories,
  submitting,
  error,
  onSubmit,
  onCancel,
  initialValues,
  mode = "create",
}: ProductFormProps) {
  const [values, setValues] = useState<ProductFormValues>({
    ...EMPTY_PRODUCT_FORM,
    ...initialValues,
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const apiError = error instanceof ApiError ? error : null;
  // outbox 경로는 일반 Error 를 던진다(서버 왕복 없이 로컬에서 바로 검증하는 경우).
  const genericError = !apiError && error instanceof Error ? error.message : null;
  const set = (patch: Partial<ProductFormValues>) => setValues((prev) => ({ ...prev, ...patch }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!values.name.trim()) {
      setLocalError("이름을 입력하세요");
      return;
    }
    if (values.quantity.trim() && !values.volumeMl.trim()) {
      setLocalError("구매 정보를 입력하려면 용량이 필요합니다");
      return;
    }
    setLocalError(null);
    onSubmit(values);
  };

  return (
    <form className="panel" aria-labelledby="product-form-heading" onSubmit={handleSubmit}>
      <h2 id="product-form-heading">{mode === "edit" ? "정보 수정" : "새 술 등록"}</h2>

      {(localError || apiError || genericError) && (
        <p className="alert" role="alert">
          {localError ?? apiError?.message ?? genericError}
        </p>
      )}

      <div className="field">
        <label htmlFor="form-name">이름 *</label>
        <input
          id="form-name"
          required
          value={values.name}
          onChange={(event) => set({ name: event.target.value })}
          aria-describedby={apiError?.errorFor("name") ? "form-name-error" : undefined}
        />
        {apiError?.errorFor("name") && (
          <span className="field-error" id="form-name-error">
            {apiError.errorFor("name")}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="form-category">주종</label>
        <select
          id="form-category"
          value={values.categoryId}
          onChange={(event) => set({ categoryId: event.target.value })}
        >
          <option value="">선택 안 함</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {formatCategoryPath(category.path)}
            </option>
          ))}
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="form-abv">도수 (%)</label>
          <input
            id="form-abv"
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={values.abv}
            onChange={(event) => set({ abv: event.target.value })}
          />
        </div>
        {mode === "create" && (
          <div className="field">
            <label htmlFor="form-volume">용량 (ml)</label>
            <input
              id="form-volume"
              type="number"
              min={1}
              value={values.volumeMl}
              onChange={(event) => set({ volumeMl: event.target.value })}
            />
          </div>
        )}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="form-vintage">빈티지</label>
          <input
            id="form-vintage"
            type="number"
            min={1800}
            max={2200}
            value={values.vintage}
            onChange={(event) => set({ vintage: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="form-rating">내 평점 (0.5~6)</label>
          <input
            id="form-rating"
            type="number"
            min={0.5}
            max={6}
            step="0.5"
            value={values.personalRating}
            onChange={(event) => set({ personalRating: event.target.value })}
          />
          {apiError?.errorFor("personal_rating") && (
            <span className="field-error">{apiError.errorFor("personal_rating")}</span>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="form-varieties">품종·스타일 (쉼표로 구분)</label>
        <input
          id="form-varieties"
          value={values.varietyNames}
          placeholder="예: Cabernet Sauvignon, Merlot"
          onChange={(event) => set({ varietyNames: event.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="form-note">메모</label>
        <textarea
          id="form-note"
          rows={2}
          value={values.note}
          onChange={(event) => set({ note: event.target.value })}
        />
      </div>

      {mode === "create" && (
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
          <legend>구매 정보 (선택)</legend>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            병수를 입력하면 구매 건과 병 기록을 함께 만듭니다. 같은 술을 나중에 다른 곳에서 사면
            구매 건을 따로 추가할 수 있습니다.
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="form-quantity">병수</label>
              <input
                id="form-quantity"
                type="number"
                min={1}
                value={values.quantity}
                onChange={(event) => set({ quantity: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="form-purchased-on">구매일</label>
              <input
                id="form-purchased-on"
                type="date"
                value={values.purchasedOn}
                onChange={(event) => set({ purchasedOn: event.target.value })}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="form-list-price">병당 정가 (원)</label>
              <input
                id="form-list-price"
                type="number"
                min={0}
                value={values.unitListPrice}
                onChange={(event) => set({ unitListPrice: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="form-paid-price">병당 실구매가 (원)</label>
              <input
                id="form-paid-price"
                type="number"
                min={0}
                value={values.unitPaidPrice}
                onChange={(event) => set({ unitPaidPrice: event.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="form-vendor">구매처</label>
            <input
              id="form-vendor"
              value={values.vendorName}
              placeholder="없으면 비워 두세요"
              onChange={(event) => set({ vendorName: event.target.value })}
            />
          </div>
        </fieldset>
      )}

      <div className="button-row" style={{ marginTop: 12 }}>
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? "저장 중…" : mode === "edit" ? "저장" : "등록"}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          취소
        </button>
      </div>
    </form>
  );
}
