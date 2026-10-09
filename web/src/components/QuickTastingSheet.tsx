/** 홈의 빠른 시음. 미개봉 병은 규격별로 고르고 입력은 계정·탭·병별로 보관한다. */
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { collectionApi } from "@/api/collection";
import { productEdition, purchaseReference } from "@/components/productDisplay";
import { TastingFields, type TastingFieldValues } from "@/components/TastingFields";
import { useToast } from "@/components/Toast";
import { formatDate, formatVolume, todayLocal } from "@/format";
import type { ProductContext } from "@/router";
import { matchesQuery } from "@/search";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import {
  captureFormDraft,
  clearFormDraft,
  clearSubmittedDraft,
  recoverableDraft,
  restoreFormDraft,
  useDraftState,
} from "@/sync/drafts";
import { type DrinkableBottle, getDrinkableBottles } from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { lastTastingContext, recordTasting, rememberTastingContext } from "@/sync/tastingActions";
import { markFormDirty } from "@/sync/update";
import { captureWriteSession } from "@/sync/writeSession";
import { useModalDialog } from "@/useModalDialog";

const SELECTION_FORM = "quick-tasting:selection";
const EMPTY_SELECTION = { bottleId: "", skuId: "", productName: "", labelNo: 0, volumeLabel: "" };
type BottleSelection = typeof EMPTY_SELECTION;

function emptyValues(): TastingFieldValues {
  const context = lastTastingContext();
  return {
    tastedOn: todayLocal(),
    pouredMl: "",
    rating: "",
    nose: "",
    palate: "",
    finish: "",
    place: context.place,
    companions: context.companions,
  };
}

function purchaseLabel(bottle: DrinkableBottle, purchaseIds: readonly string[]): string {
  return `#${bottle.labelNo} · 구매 ${formatDate(bottle.purchasedOn)} · ${bottle.vendorName ?? "구매처 미기록"} · ${purchaseReference(bottle.purchaseId, purchaseIds)}`;
}
function bottleProductLabel(bottle: DrinkableBottle): string {
  const edition = productEdition({
    vintage: bottle.vintage,
    abv: bottle.abv,
    age_years: bottle.ageYears,
  });
  return edition ? `${bottle.productName} · ${edition}` : bottle.productName;
}

export function QuickTastingSheet({
  onClose,
  returnFocusRef,
  onSelectProduct,
}: {
  onClose: () => void;
  onSelectProduct?: ((productId: string, context?: ProductContext) => void) | undefined;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useModalDialog(returnFocusRef);
  const [session] = useState(captureWriteSession);
  const bottles = useLiveQuery(() => getDrinkableBottles(), [session.userId]);
  const purchaseIds = (bottles ?? []).map((bottle) => bottle.purchaseId);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useDraftState(SELECTION_FORM, EMPTY_SELECTION);
  const [scope, setScope] = useState<"all" | "sku" | null>(null);
  const [carry, setCarry] = useState<TastingFieldValues | null>(null);
  const [recovery, setRecovery] = useState(() => recoverableDraft(SELECTION_FORM));
  const [restoreSource, setRestoreSource] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { state } = useSyncStatus();
  const offline = state === "offline" || !navigator.onLine;
  const locations = useQuery({
    queryKey: ["quick-tasting", "locations", session.userId],
    enabled: !offline && session.isCurrent(),
    retry: false,
    queryFn: async () => {
      session.assertCurrent();
      const [inventory, places] = await Promise.all([
        collectionApi.bottles(),
        collectionApi.locations(),
      ]);
      session.assertCurrent();
      const names = new Map(
        places.filter((place) => !place.deleted).map((place) => [place.id, place.name]),
      );
      return new Map(
        inventory.map((bottle) => [
          bottle.id,
          bottle.location_id
            ? (names.get(bottle.location_id) ?? "위치 확인 불가")
            : bottle.legacy_location || "위치 미지정",
        ]),
      );
    },
  });
  const locationLabel = (bottleId: string): string =>
    offline
      ? "위치 확인 불가 (오프라인)"
      : locations.isPending
        ? "위치 확인 중…"
        : locations.isError
          ? "위치 확인 불가"
          : (locations.data?.get(bottleId) ?? "위치 확인 불가");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !savingRef.current) onClose();
    }
    const refreshRecovery = () => setRecovery(recoverableDraft(SELECTION_FORM));
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("storage", refreshRecovery);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("storage", refreshRecovery);
    };
  }, [onClose]);

  const visible = useMemo(() => {
    const counts = new Map<string, number>();
    const rows: (DrinkableBottle & { unopenedCount?: number })[] = [];
    for (const item of bottles ?? []) {
      if (scope === "sku" && item.skuId !== selection.skuId) continue;
      if (query.trim() && !matchesQuery(bottleProductLabel(item), query)) continue;
      if (scope !== "sku" && item.status === "unopened") {
        const seen = counts.get(item.skuId) ?? 0;
        counts.set(item.skuId, seen + 1);
        if (seen > 0) continue;
      }
      rows.push(item);
    }
    return rows.map((row) =>
      scope !== "sku" && row.status === "unopened"
        ? { ...row, unopenedCount: counts.get(row.skuId) }
        : row,
    );
  }, [bottles, query, scope, selection.skuId]);
  const choosing = !selection.bottleId || scope !== null;
  const selectedBottle = bottles?.find((bottle) => bottle.bottleId === selection.bottleId) ?? null;

  function choose(bottle: DrinkableBottle): void {
    if (!session.isCurrent()) return;
    setSelection({
      bottleId: bottle.bottleId,
      skuId: bottle.skuId,
      productName: bottleProductLabel(bottle),
      labelNo: bottle.labelNo,
      volumeLabel: formatVolume(bottle.volumeMl),
    });
    setRestoreSource(null);
    setScope(null);
    setQuery("");
  }

  return (
    <div className="sheet-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-tasting-heading"
        tabIndex={-1}
        className="bottom-sheet"
      >
        <div className="section-heading-row">
          <h2 id="quick-tasting-heading" className="mb-0">
            {choosing
              ? "무엇을 마셨나요?"
              : selectedBottle
                ? bottleProductLabel(selectedBottle)
                : selection.productName}
          </h2>
          <button
            type="button"
            className="btn-quiet"
            disabled={saving}
            onClick={() => {
              if (!savingRef.current) onClose();
            }}
          >
            닫기
          </button>
        </div>
        {!choosing && selectedBottle && onSelectProduct ? (
          <button
            type="button"
            className="link-like"
            disabled={saving}
            onClick={() => {
              if (savingRef.current) return;
              onClose();
              onSelectProduct(selectedBottle.productId, {
                skuId: selectedBottle.skuId,
                bottleId: selectedBottle.bottleId,
              });
            }}
          >
            이 병 상세
          </button>
        ) : null}
        {choosing ? (
          <>
            {recovery ? (
              <button
                type="button"
                onClick={() => {
                  restoreFormDraft(SELECTION_FORM, recovery);
                  setRestoreSource(recovery);
                  setRecovery(null);
                  setCarry(null);
                  setScope(null);
                }}
              >
                이전 입력 불러오기
              </button>
            ) : null}
            {scope === "sku" ? (
              <>
                <p>같은 규격의 병을 고르세요. 구매일이 오래된 미개봉 병을 기본으로 선택합니다.</p>
                <button type="button" onClick={() => setScope("all")}>
                  전체 술에서 고르기
                </button>
              </>
            ) : null}
            <label className="field">
              <span>술 이름 검색</span>
              <input
                type="search"
                value={query}
                placeholder="한글·초성 검색"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {bottles === undefined ? <output>불러오는 중…</output> : null}
            {bottles !== undefined && bottles.length === 0 ? (
              <p className="muted">재고가 있는 술이 없습니다. 내 술에서 구매를 먼저 기록하세요.</p>
            ) : null}
            {bottles && bottles.length > 0 && visible.length === 0 ? (
              <p>조건에 맞는 병이 없습니다.</p>
            ) : null}
            <ul className="pick-list">
              {visible.map((item) => (
                <li key={item.bottleId}>
                  <button type="button" onClick={() => choose(item)}>
                    <span>
                      {bottleProductLabel(item)} · {formatVolume(item.volumeMl)}{" "}
                      {item.status === "open" || scope === "sku" ? `#${item.labelNo}` : ""}
                    </span>
                    <span className={`bottle-badge bottle-badge-${item.status}`}>
                      {item.status === "open"
                        ? item.remainingMl !== null
                          ? `개봉 · ${item.remainingMl}ml`
                          : "개봉"
                        : `미개봉 ${item.unopenedCount ?? 1}병`}
                    </span>
                    {scope === "sku" || item.status === "open" ? (
                      <span className="muted text-sm">
                        {purchaseLabel(item, purchaseIds)} · {locationLabel(item.bottleId)}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <QuickTastingForm
            key={selection.bottleId}
            selection={selection}
            purchaseIds={purchaseIds}
            bottle={selectedBottle}
            loading={bottles === undefined}
            location={locationLabel(selection.bottleId)}
            initialValues={carry}
            restoreSource={restoreSource}
            saving={saving}
            isSaving={() => savingRef.current}
            beginSaving={() => {
              if (savingRef.current) return false;
              savingRef.current = true;
              setSaving(true);
              return true;
            }}
            finishSaving={() => {
              savingRef.current = false;
              setSaving(false);
            }}
            onClose={onClose}
            onChooseAnother={(values, all) => {
              if (savingRef.current) return;
              setCarry(values);
              setScope(all ? "all" : "sku");
              setQuery("");
            }}
          />
        )}
      </div>
    </div>
  );
}

function QuickTastingForm({
  selection,
  purchaseIds,
  bottle,
  loading,
  location,
  initialValues,
  restoreSource,
  saving,
  isSaving,
  beginSaving,
  finishSaving,
  onClose,
  onChooseAnother,
}: {
  selection: BottleSelection;
  purchaseIds: readonly string[];
  bottle: DrinkableBottle | null;
  loading: boolean;
  location: string;
  initialValues: TastingFieldValues | null;
  restoreSource: string | null;
  saving: boolean;
  isSaving: () => boolean;
  beginSaving: () => boolean;
  finishSaving: () => void;
  onClose: () => void;
  onChooseAnother: (values: TastingFieldValues, all: boolean) => void;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [session] = useState(captureWriteSession);
  const formId = `quick-tasting:bottle:${selection.bottleId}`;
  const [empty] = useState(emptyValues);
  const [values, setValues] = useDraftState<TastingFieldValues>(
    formId,
    () => initialValues ?? empty,
  );
  const [hadTargetDraft] = useState(
    () => initialValues !== null && JSON.stringify(values) !== JSON.stringify(initialValues),
  );
  const [error, setError] = useState<string | null>(null);
  const unavailable = !loading && !bottle;
  const firstMount = useRef(true);

  useEffect(() => {
    if (!firstMount.current) return;
    firstMount.current = false;
    if (initialValues) {
      setValues((current) => current);
      if (formRef.current) markFormDirty(formRef.current);
    }
  }, [initialValues, setValues]);

  useEffect(() => {
    if (restoreSource) {
      restoreFormDraft(formId, restoreSource);
      if (formRef.current) markFormDirty(formRef.current);
    }
  }, [formId, restoreSource]);

  useEffect(() => {
    if (JSON.stringify(values) !== JSON.stringify(empty) && formRef.current)
      markFormDirty(formRef.current);
  }, [values, empty]);

  async function save(): Promise<void> {
    if (!bottle || !beginSaving()) return;
    setError(null);
    const submittedDraft = captureFormDraft(formId);
    const submittedSelection = captureFormDraft(SELECTION_FORM);
    try {
      session.assertCurrent();
      const effect = await session.store.transaction("rw", session.store.tables, async () => {
        session.assertCurrent();
        const current = await session.store.bottle.get(selection.bottleId);
        if (
          !current ||
          current.deleted_at !== null ||
          !["open", "unopened"].includes(String(current.status))
        )
          throw new Error(
            "이 병에는 더 이상 시음을 기록할 수 없습니다. 입력은 보관했습니다. 다른 병을 고르세요.",
          );
        await recordTasting({
          bottleId: selection.bottleId,
          tastedOn: values.tastedOn,
          pouredMl: values.pouredMl ? Number(values.pouredMl) : null,
          rating: values.rating || null,
          nose: values.nose,
          palate: values.palate,
          finish: values.finish,
          place: values.place,
          companions: values.companions,
          userId: session.userId,
        });
        session.assertCurrent();
        const updated = await session.store.bottle.get(selection.bottleId);
        return updated?.status === "finished"
          ? " (다 마셔 소진 처리)"
          : current.status === "unopened"
            ? " (개봉 처리)"
            : "";
      });
      session.assertCurrent();
      rememberTastingContext({ place: values.place.trim(), companions: values.companions.trim() });
      const cleared = clearSubmittedDraft(submittedDraft);
      const selectionCleared = clearSubmittedDraft(submittedSelection);
      toast.show({ message: `${bottle.productName} 시음을 기록했습니다${effect}` });
      if (cleared && selectionCleared) onClose();
    } catch (cause) {
      if (session.isCurrent())
        setError(cause instanceof Error ? cause.message : "기록하지 못했습니다");
    } finally {
      finishSaving();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="muted text-sm mt-0">
        {bottle
          ? `${formatVolume(bottle.volumeMl)} · ${purchaseLabel(bottle, purchaseIds)}`
          : `${selection.volumeLabel} · #${selection.labelNo}`}{" "}
        · {location}
      </p>
      {bottle?.status === "unopened" ? (
        <p className="muted text-sm">저장하면 이 병을 개봉 처리합니다.</p>
      ) : null}
      <fieldset disabled={saving} style={{ border: 0, padding: 0 }}>
        <DraftRecoveryButton form={formId} />
        {loading ? <output>병 상태를 확인하고 있습니다…</output> : null}
        {unavailable ? (
          <p className="alert" role="alert">
            선택한 병을 사용할 수 없습니다. 삭제되었거나 이미 내보낸 병일 수 있습니다. 작성 중인
            입력은 보관했습니다.
          </p>
        ) : null}
        {hadTargetDraft ? (
          <p>선택한 병의 기존 입력을 불러왔습니다. 이전 병의 입력도 보관 중입니다.</p>
        ) : null}
        <TastingFields
          values={values}
          remainingMl={
            bottle ? (bottle.status === "open" ? bottle.remainingMl : bottle.volumeMl) : null
          }
          onChange={(patch) => {
            if (isSaving()) return;
            setValues((current) => ({ ...current, ...patch }));
            if (formRef.current) markFormDirty(formRef.current);
          }}
        />
      </fieldset>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" className="primary" disabled={saving || !bottle}>
          {saving ? "저장 중…" : "기록 저장"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onChooseAnother(values, unavailable)}
        >
          {unavailable ? "다른 병으로 이어서 기록" : "병 변경"}
        </button>
        {!unavailable ? (
          <button type="button" disabled={saving} onClick={() => onChooseAnother(values, true)}>
            다른 술 고르기
          </button>
        ) : null}
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            if (isSaving() || !session.isCurrent()) return;
            clearFormDraft(formId, session.userId);
            clearFormDraft(SELECTION_FORM, session.userId);
            onClose();
          }}
        >
          작성 중인 입력 삭제
        </button>
      </div>
    </form>
  );
}
