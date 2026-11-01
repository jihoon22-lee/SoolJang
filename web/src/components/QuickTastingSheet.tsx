/** 홈의 빠른 시음. 미개봉 병은 규격별로 고르고 입력은 계정·탭·병별로 보관한다. */
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { collectionApi } from "@/api/collection";
import { BottleGauge } from "@/components/BottleGauge";
import {
  bottleProductLabel,
  bottlePurchaseIdentity,
  bottlePurchaseLabel,
  sameLookingBottleIds,
} from "@/components/drinkableBottleLabel";
import { purchaseReferences } from "@/components/productDisplay";
import { TastingFields, type TastingFieldValues } from "@/components/TastingFields";
import { useToast } from "@/components/Toast";
import { formatVolume } from "@/format";
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
import { recordTasting, rememberTastingContext } from "@/sync/tastingActions";
import { emptyTastingValues, tastingDraftKey, useTastingDraft } from "@/sync/tastingDraft";
import { markFormDirty } from "@/sync/update";
import { captureWriteSession } from "@/sync/writeSession";
import { useModalDialog } from "@/useModalDialog";

const SELECTION_FORM = "quick-tasting:selection";
const EMPTY_SELECTION = { bottleId: "", skuId: "", productName: "", labelNo: 0, volumeLabel: "" };
type BottleSelection = typeof EMPTY_SELECTION;

/** 저장이 끝나 초안까지 정리된 시음. 이어서 할 일(고치기·한 잔 더·보기)은 시트를 연 쪽이 띄운다. */
export interface RecordedTasting {
  tastingId: string;
  bottle: DrinkableBottle;
  /** "… 시음을 기록했습니다 (개봉 처리)" */
  message: string;
  /** 이 기록으로 병을 다 마셔 같은 병에 더 기록할 수 없다. */
  finished: boolean;
}

export function QuickTastingSheet({
  onClose,
  onRecorded,
  returnFocusRef,
  onSelectProduct,
  initialBottle,
}: {
  onClose: () => void;
  /** 저장과 초안 정리가 끝나면 부른 뒤 시트를 닫는다(D267). 결과 미확정·실패는 시트에 남는다. */
  onRecorded: (recorded: RecordedTasting) => void;
  onSelectProduct?: ((productId: string, context?: ProductContext) => void) | undefined;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  /** 홈 열린 병의 "한 잔"처럼 병을 정하고 열 때. 다른 병의 작성 중 입력은 그 병에 남는다. */
  initialBottle?: DrinkableBottle | undefined;
}) {
  const dialogRef = useModalDialog(returnFocusRef);
  const [session] = useState(captureWriteSession);
  const bottles = useLiveQuery(() => getDrinkableBottles(), [session.userId]);
  // 병마다 전체 목록을 다시 비교하지 않도록 구매 참조를 한 번만 계산한다(D264).
  const references = useMemo(
    () => purchaseReferences((bottles ?? []).map(bottlePurchaseIdentity)),
    [bottles],
  );
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useDraftState(SELECTION_FORM, EMPTY_SELECTION);
  const [scope, setScope] = useState<"all" | "sku" | null>(null);
  const [carry, setCarry] = useState<TastingFieldValues | null>(null);
  const [recovery, setRecovery] = useState(() => recoverableDraft(SELECTION_FORM));
  const [restoreSource, setRestoreSource] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // 저장된 선택 초안이 다른 병을 가리켜도 고른 병으로 연다. 입력 초안은 병별 키라 그대로다.
  const [preselect, setPreselect] = useState(initialBottle ?? null);
  if (preselect) {
    setPreselect(null);
    if (selection.bottleId !== preselect.bottleId) choose(preselect);
  }
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
      if (
        query.trim() &&
        ![bottleProductLabel(item), ...(item.searchNames ?? [])].some((name) =>
          matchesQuery(name, query),
        )
      )
        continue;
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
  // 같은 이름·용량으로 보이는 병이 둘 이상일 때만 구매·위치 줄로 구분한다(D264와 같은 원칙).
  // 병을 고르면 입력 머리에 번호·구매·위치를 모두 보인다.
  const needsDetail = useMemo(
    () => sameLookingBottleIds(visible.filter((item) => scope === "sku" || item.status === "open")),
    [visible, scope],
  );
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
                  <button type="button" className="pick-bottle" onClick={() => choose(item)}>
                    <BottleGauge
                      status={item.status}
                      remainingMl={item.remainingMl}
                      volumeMl={item.volumeMl}
                    />
                    <span className="pick-bottle-text">
                      <span>
                        {bottleProductLabel(item)} · {formatVolume(item.volumeMl)}{" "}
                        {item.status === "open" || scope === "sku" ? `#${item.labelNo}` : ""}
                      </span>
                      {needsDetail.has(item.bottleId) ? (
                        <span className="muted text-sm">
                          {bottlePurchaseLabel(item, references)} · {locationLabel(item.bottleId)}
                        </span>
                      ) : null}
                    </span>
                    <span className={`bottle-badge bottle-badge-${item.status}`}>
                      {item.status === "open"
                        ? item.remainingMl !== null
                          ? `개봉 · ${item.remainingMl}ml`
                          : "개봉"
                        : `미개봉 ${item.unopenedCount ?? 1}병`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <QuickTastingForm
            key={selection.bottleId}
            selection={selection}
            references={references}
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
            onRecorded={(recorded) => {
              onRecorded(recorded);
              onClose();
            }}
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
  references,
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
  onRecorded,
}: {
  selection: BottleSelection;
  references: ReadonlyMap<string, string>;
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
  onRecorded: (recorded: RecordedTasting) => void;
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [session] = useState(captureWriteSession);
  const formId = tastingDraftKey(selection.bottleId);
  const [empty] = useState(emptyTastingValues);
  const [values, setValues] = useTastingDraft(selection.bottleId, initialValues ?? empty);
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
    const legacyDraft = captureFormDraft(`tasting:${selection.bottleId}`);
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
        const id = await recordTasting({
          bottleId: selection.bottleId,
          tastedOn: values.tastedOn,
          pouredMl: values.pouredMl ? Number(values.pouredMl) : null,
          rating: values.rating || null,
          note: values.note,
          nose: values.nose,
          palate: values.palate,
          finish: values.finish,
          place: values.place,
          companions: values.companions,
          userId: session.userId,
        });
        session.assertCurrent();
        const updated = await session.store.bottle.get(selection.bottleId);
        const finished = updated?.status === "finished";
        const label = finished
          ? " (다 마셔 소진 처리)"
          : current.status === "unopened"
            ? " (개봉 처리)"
            : "";
        return { id, label, finished };
      });
      session.assertCurrent();
      rememberTastingContext({ place: values.place.trim(), companions: values.companions.trim() });
      const cleared = clearSubmittedDraft(submittedDraft);
      if (cleared) clearSubmittedDraft(legacyDraft);
      const selectionCleared = clearSubmittedDraft(submittedSelection);
      const message = `${bottle.productName} 시음을 기록했습니다${effect.label}`;
      if (cleared && selectionCleared)
        onRecorded({ tastingId: effect.id, bottle, message, finished: effect.finished });
      // 저장 중 다른 탭이 같은 입력을 바꿨다. 기록은 남았고 바뀐 입력은 시트에 그대로 둔다(D248).
      else toast.show({ message });
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
          ? `${formatVolume(bottle.volumeMl)} · ${bottlePurchaseLabel(bottle, references)}`
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
