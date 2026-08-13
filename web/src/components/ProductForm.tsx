import { useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import type { CategoryNode } from "@/api/types";
import { AutocompleteInput } from "@/components/AutocompleteInput";
import { formatCategoryPath } from "@/format";
import { getLastVendorName } from "@/lastVendor";
import { normalizeNameForMatching, rankByQuery } from "@/search";

//: 자동완성이 한 번에 보여줄 후보 수. 405종 목록에서도 스크롤 없이 훑을 수 있는 정도.
const MAX_SUGGESTIONS = 8;

export interface ProductFormValues {
  name: string;
  categoryId: string;
  producerName: string;
  abv: string;
  vintage: string;
  ageYears: string;
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

function isPositiveInteger(raw: string): boolean {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0;
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  name: "",
  categoryId: "",
  producerName: "",
  abv: "",
  vintage: "",
  ageYears: "",
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
  /** 이름 자동완성 후보이자 중복 등록 경고의 대상. `mode === "edit"` 이면 쓰지 않는다
   * (수정 중인 제품 자기 자신은 항상 이름이 일치하므로 경고 대상에서 뺄 방법이 없다). */
  existingProducts?: { id: string; name: string }[];
  /** 이미 등록된 술과 이름이 정확히 일치하면 이 콜백으로 그 제품으로 건너뛸 수 있게 한다. */
  onSelectExisting?: (productId: string) => void;
  /** 구매처 자동완성 후보. */
  vendorNames?: string[];
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
  existingProducts = [],
  onSelectExisting,
  vendorNames = [],
}: ProductFormProps) {
  const [values, setValues] = useState<ProductFormValues>({
    ...EMPTY_PRODUCT_FORM,
    purchasedOn: new Date().toISOString().slice(0, 10),
    vendorName: getLastVendorName(),
    ...initialValues,
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const apiError = error instanceof ApiError ? error : null;
  // outbox 경로는 일반 Error 를 던진다(서버 왕복 없이 로컬에서 바로 검증하는 경우).
  const genericError = !apiError && error instanceof Error ? error.message : null;
  const set = (patch: Partial<ProductFormValues>) => setValues((prev) => ({ ...prev, ...patch }));

  const nameSuggestions = useMemo(
    () =>
      rankByQuery(existingProducts, values.name, (p) => p.name)
        .slice(0, MAX_SUGGESTIONS)
        .map((p) => p.name),
    [existingProducts, values.name],
  );
  const vendorSuggestions = useMemo(
    () => rankByQuery(vendorNames, values.vendorName, (name) => name).slice(0, MAX_SUGGESTIONS),
    [vendorNames, values.vendorName],
  );
  // 수정 중인 제품은 자기 자신과 항상 이름이 일치하므로 경고 대상에서 뺀다.
  const duplicateProduct =
    mode === "create" && values.name.trim()
      ? existingProducts.find(
          (p) => normalizeNameForMatching(p.name) === normalizeNameForMatching(values.name),
        )
      : undefined;

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
    // 정수가 아닌 병수(예: "2.5")는 낙관적 병 id 개수와 서버가 저장하는 병수가
    // 어긋나 오프라인 동기화 큐가 영구히 막히는 결함으로 실사용 중 발견됐다 —
    // `step={1}` 만으로는 브라우저 기본 검증에만 의존하게 되므로 여기서도 확실히 막는다.
    if (values.quantity.trim() && !isPositiveInteger(values.quantity)) {
      setLocalError("병수는 1 이상의 정수를 입력하세요");
      return;
    }
    if (values.volumeMl.trim() && !isPositiveInteger(values.volumeMl)) {
      setLocalError("용량(ml)은 1 이상의 정수를 입력하세요");
      return;
    }
    setLocalError(null);
    onSubmit(values);
  };

  return (
    <form
      className="panel"
      aria-labelledby="product-form-heading"
      onSubmit={handleSubmit}
      // `step`/`min`/`max` 는 스피너·모바일 키패드 힌트로만 쓴다 — 브라우저 기본 검증에
      // 맡기면 브라우저마다 다른 말풍선이 뜨고 제출 이벤트 자체가 안 일어나(위 `step`
      // 위반 시 `handleSubmit` 이 아예 호출 안 됨), 다른 모든 검증과 다르게 이 페이지
      // 톤에 안 맞는 UI 가 튀어나온다. 검증은 전부 `handleSubmit` 의 `.alert` 로 통일한다.
      noValidate
    >
      <h2 id="product-form-heading">{mode === "edit" ? "정보 수정" : "새 술 등록"}</h2>

      {(localError || apiError || genericError) && (
        <p className="alert" role="alert">
          {localError ?? apiError?.message ?? genericError}
        </p>
      )}

      <div className="field">
        <label htmlFor="form-name">이름 *</label>
        <AutocompleteInput
          id="form-name"
          required
          value={values.name}
          onChange={(name) => set({ name })}
          suggestions={nameSuggestions}
          aria-describedby={apiError?.errorFor("name") ? "form-name-error" : undefined}
        />
        {apiError?.errorFor("name") && (
          <span className="field-error" id="form-name-error">
            {apiError.errorFor("name")}
          </span>
        )}
        {duplicateProduct && (
          <output className="muted">
            이미 등록된 술입니다 —{" "}
            <button
              type="button"
              className="link-like"
              onClick={() => onSelectExisting?.(duplicateProduct.id)}
            >
              구매 이력 추가하시겠어요?
            </button>
          </output>
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
              max={100_000}
              step={1}
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

      <div className="field-row">
        <div className="field">
          <label htmlFor="form-producer">생산자</label>
          <input
            id="form-producer"
            value={values.producerName}
            placeholder="예: 글렌피딕"
            onChange={(event) => set({ producerName: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="form-age-years">숙성 연수</label>
          <input
            id="form-age-years"
            type="number"
            min={0}
            step="0.1"
            value={values.ageYears}
            onChange={(event) => set({ ageYears: event.target.value })}
          />
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
        <fieldset className="fieldset-bordered">
          <legend>구매 정보 (선택)</legend>
          <p className="muted text-sm mt-0">
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
                max={1000}
                step={1}
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
            <AutocompleteInput
              id="form-vendor"
              value={values.vendorName}
              placeholder="없으면 비워 두세요"
              onChange={(vendorName) => set({ vendorName })}
              suggestions={vendorSuggestions}
            />
          </div>
        </fieldset>
      )}

      <div className="button-row mt-3">
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
