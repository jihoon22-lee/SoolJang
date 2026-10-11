import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ApiError, bottlesApi, productsApi, tastingsApi } from "@/api/client";
import type {
  BottleCorrectionContext,
  BottleGuard,
  ContextualTasting,
  CorrectionBottleOption,
  FinalBottleState,
  ProductSkuContext,
  TastingCorrectionInput,
} from "@/api/types";
import { STATUS_LABELS } from "@/components/BottlePanel";
import { FinalBottleStateFields, finalStateOf } from "@/components/FinalBottleStateFields";
import { HistoryDetails } from "@/components/HistoryList";
import { productEdition, purchaseReference } from "@/components/productDisplay";
import { TastingFields, type TastingFieldValues } from "@/components/TastingFields";
import { formatVolume } from "@/format";
import { getCorrectionBlockReason, submitTastingCorrection } from "@/sync/corrections";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { databaseIdentity } from "@/sync/db";
import { captureFormDraft, clearSubmittedDraft, useDraftState } from "@/sync/drafts";
import { getLocalTasting } from "@/sync/tastingHistory";
import { useSessionMutation } from "@/sync/useSessionMutation";
import { captureWriteSession } from "@/sync/writeSession";

export interface TastingCorrectionFormProps {
  tastingId: string;
  offline: boolean;
  bottleOptions: CorrectionBottleOption[] | undefined;
  skuOptions: ProductSkuContext[] | undefined;
  onSavingChange: (saving: boolean) => void;
  onSaved: (result: ContextualTasting) => void;
  onCancel: () => void;
}

type Fields = TastingFieldValues & { note: string; bottleId: string; skuId: string };
type Attempt = {
  signature: string;
  input: TastingCorrectionInput;
  outcome: "unknown" | "conflict" | "rejected";
};
type Draft = {
  version: 1;
  tastingId: string;
  fields: Fields;
  mode: "preserve" | "set_final";
  finals: FinalBottleState[];
  attempt: Attempt | null;
  reviewRequired: boolean;
  checkedVersion: string;
  checkedBottles: BottleGuard[];
  checkedSku?: ProductSkuContext | null | undefined;
};
const FIELD_KEYS = [
  "tastedOn",
  "pouredMl",
  "rating",
  "nose",
  "palate",
  "finish",
  "place",
  "companions",
  "note",
  "bottleId",
  "skuId",
] as const;
const CHANGE_KEYS = [
  "bottle_id",
  "sku_id",
  "tasted_on",
  "poured_ml",
  "rating",
  "nose",
  "palate",
  "finish",
  "note",
  "place",
  "companions",
];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100000;
}
function nullableString(value: unknown): boolean {
  return value === null || string(value);
}
function validGuards(value: unknown): value is BottleGuard[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        object(item) &&
        onlyKeys(item, ["id", "revision"]) &&
        string(item.id) &&
        item.id.length > 0 &&
        string(item.revision),
    ) &&
    new Set(value.map((item: BottleGuard) => item.id)).size === value.length
  );
}
function validSku(value: unknown): value is ProductSkuContext {
  return (
    object(value) &&
    onlyKeys(value, [
      "product_id",
      "product_name",
      "vintage",
      "age_years",
      "abv",
      "sku_id",
      "volume_ml",
    ]) &&
    string(value.product_id) &&
    string(value.product_name) &&
    string(value.sku_id) &&
    (value.vintage === null || Number.isInteger(value.vintage)) &&
    nullableString(value.age_years) &&
    nullableString(value.abv) &&
    Number.isInteger(value.volume_ml) &&
    Number(value.volume_ml) > 0
  );
}
function skuStamp(context: ProductSkuContext): string {
  return JSON.stringify([
    context.product_id,
    context.product_name,
    context.vintage,
    context.age_years,
    context.abv,
    context.sku_id,
    context.volume_ml,
  ]);
}
function validFinal(value: unknown): value is FinalBottleState {
  return (
    object(value) &&
    onlyKeys(value, ["id", "status", "remaining_ml", "opened_on", "finished_on"]) &&
    string(value.id) &&
    value.id.length > 0 &&
    string(value.status) &&
    Object.hasOwn(STATUS_LABELS, value.status) &&
    (value.remaining_ml === null ||
      (Number.isInteger(value.remaining_ml) && Number(value.remaining_ml) >= 0)) &&
    nullableString(value.opened_on) &&
    nullableString(value.finished_on)
  );
}
function validInput(value: unknown): value is TastingCorrectionInput {
  if (
    !object(value) ||
    !onlyKeys(value, [
      "request_id",
      "expected_updated_at",
      "changes",
      "expected_bottles",
      "remaining_mode",
      "final_bottles",
      "target_sku_expected_volume_ml",
    ])
  )
    return false;
  if (
    !string(value.request_id) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.request_id) ||
    !string(value.expected_updated_at) ||
    !Number.isFinite(Date.parse(value.expected_updated_at)) ||
    !object(value.changes) ||
    !onlyKeys(value.changes, CHANGE_KEYS) ||
    !Array.isArray(value.expected_bottles) ||
    !Array.isArray(value.final_bottles) ||
    !value.final_bottles.every(validFinal) ||
    !["preserve", "set_final"].includes(String(value.remaining_mode))
  )
    return false;
  if (
    !value.expected_bottles.every(
      (item: unknown) =>
        object(item) &&
        onlyKeys(item, ["id", "revision"]) &&
        string(item.id) &&
        item.id.length > 0 &&
        string(item.revision) &&
        item.revision.length > 0,
    )
  )
    return false;
  if (
    new Set(value.expected_bottles.map((item) => (item as { id: string }).id)).size !==
    value.expected_bottles.length
  )
    return false;
  for (const [key, field] of Object.entries(value.changes)) {
    if (key === "poured_ml") {
      if (field !== null && (!Number.isInteger(field) || Number(field) <= 0)) return false;
    } else if (!nullableString(field)) return false;
  }
  return (
    value.target_sku_expected_volume_ml === undefined ||
    (Number.isInteger(value.target_sku_expected_volume_ml) &&
      Number(value.target_sku_expected_volume_ml) > 0)
  );
}
function initialDraft(item: ContextualTasting): Draft {
  return {
    version: 1,
    tastingId: item.id,
    fields: {
      tastedOn: item.tasted_on,
      pouredMl: item.poured_ml === null ? "" : String(item.poured_ml),
      rating: item.rating ?? "",
      nose: item.nose ?? "",
      palate: item.palate ?? "",
      finish: item.finish ?? "",
      place: item.place ?? "",
      companions: item.companions ?? "",
      note: item.note ?? "",
      bottleId: item.bottle_id ?? "",
      skuId: item.sku_id,
    },
    mode: "preserve",
    finals: [],
    attempt: null,
    reviewRequired: false,
    checkedVersion: item.updated_at,
    checkedBottles: item.bottle ? [{ id: item.bottle.id, revision: item.bottle.revision }] : [],
    checkedSku: item.bottle_id === null ? item.context : null,
  };
}
/** Stored JSON is user-controlled. Only the versioned, fully checked submission shape is restored. */
function parseDraft(raw: string, fallback: Draft): { value: Draft; invalid: boolean } {
  if (!raw) return { value: fallback, invalid: false };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      !onlyKeys(value, [
        "version",
        "tastingId",
        "fields",
        "mode",
        "finals",
        "attempt",
        "reviewRequired",
        "checkedVersion",
        "checkedBottles",
        "checkedSku",
      ]) ||
      value.version !== 1 ||
      value.tastingId !== fallback.tastingId ||
      !object(value.fields) ||
      !onlyKeys(value.fields, FIELD_KEYS) ||
      !FIELD_KEYS.every((key) => string((value.fields as Record<string, unknown>)[key])) ||
      !["preserve", "set_final"].includes(String(value.mode)) ||
      !Array.isArray(value.finals) ||
      !value.finals.every(validFinal) ||
      !string(value.checkedVersion) ||
      !validGuards(value.checkedBottles) ||
      (value.checkedSku !== undefined &&
        value.checkedSku !== null &&
        !validSku(value.checkedSku)) ||
      typeof value.reviewRequired !== "boolean"
    )
      throw new Error();
    if (
      value.attempt !== null &&
      (!object(value.attempt) ||
        !onlyKeys(value.attempt, ["signature", "input", "outcome"]) ||
        !string(value.attempt.signature) ||
        !validInput(value.attempt.input) ||
        !["unknown", "conflict", "rejected"].includes(String(value.attempt.outcome)))
    )
      throw new Error();
    return { value: value as unknown as Draft, invalid: false };
  } catch {
    return { value: fallback, invalid: true };
  }
}
function label(context: ProductSkuContext): string {
  return [context.product_name, productEdition(context), formatVolume(context.volume_ml)]
    .filter(Boolean)
    .join(" · ");
}
function sourceContext(item: ContextualTasting): BottleCorrectionContext | null {
  return item.bottle && item.purchase
    ? { context: item.context, purchase: item.purchase, bottle: item.bottle }
    : null;
}

/** The editor mounts only after a known record is read, so drafts never start from an empty placeholder. */
export function TastingCorrectionForm(props: TastingCorrectionFormProps) {
  const [identity] = useState(databaseIdentity);
  const [session] = useState(captureWriteSession);
  const recordKey = `${identity.userId}:${identity.generation}:${props.tastingId}`;
  const [loadedRecord, setLoadedRecord] = useState<{
    key: string;
    record: ContextualTasting;
    unconfirmed: boolean;
  } | null>(null);
  const record = useQuery({
    staleTime: 0,
    refetchOnMount: "always",
    networkMode: props.offline ? "always" : "online",
    queryKey: [
      "tastings",
      "correction",
      identity.userId,
      identity.generation,
      props.tastingId,
      props.offline ? "local" : "server",
    ],
    queryFn: async ({ signal }) => {
      session.assertCurrent();
      const item = props.offline
        ? await getLocalTasting(props.tastingId)
        : await tastingsApi.get(props.tastingId, signal).catch(async (cause: unknown) => {
            if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
            const pending = await getCorrectionBlockReason(session, [props.tastingId]);
            const local = pending ? await getLocalTasting(props.tastingId) : null;
            if (!local) throw cause;
            return { ...local, unconfirmed: true };
          });
      session.assertCurrent();
      return item;
    },
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!record.isSuccess || !record.isFetchedAfterMount || record.isFetching || !record.data)
      return;
    const fresh = record.data;
    setLoadedRecord((previous) =>
      previous?.key === recordKey
        ? previous
        : { key: recordKey, record: fresh, unconfirmed: "unconfirmed" in fresh },
    );
  }, [record.isSuccess, record.isFetchedAfterMount, record.isFetching, record.data, recordKey]);
  // Cached context may predate a later tasting on the same bottle. Start from the first fresh
  // read, then retain that baseline while editing; later refetches must not rebase the draft.
  const initialRecord = loadedRecord?.key === recordKey ? loadedRecord.record : null;
  return (
    <section className="tasting-correction" aria-label="시음 기록 수정">
      <h3>시음 기록 수정</h3>
      {!initialRecord && record.isFetching ? <output>정정할 기록을 불러오는 중…</output> : null}
      {record.isError ? (
        <p role="alert">정정할 기록을 확인하지 못했습니다. 저장된 입력은 유지됩니다.</p>
      ) : null}
      {record.isSuccess && !record.data ? (
        <p role="alert">이 기기에서 정정할 기록을 찾을 수 없습니다. 온라인에서 다시 확인하세요.</p>
      ) : null}
      {!initialRecord ? (
        <div className="button-row">
          <button type="button" disabled={record.isFetching} onClick={() => void record.refetch()}>
            기록 다시 확인
          </button>
          <button type="button" onClick={props.onCancel}>
            취소
          </button>
        </div>
      ) : (
        <CorrectionEditor
          key={recordKey}
          {...props}
          initialRecord={initialRecord}
          initialUnconfirmed={loadedRecord?.unconfirmed ?? false}
          readFailed={record.isError || record.isFetching}
        />
      )}
    </section>
  );
}

function CorrectionEditor({
  tastingId,
  offline,
  bottleOptions,
  skuOptions,
  onSavingChange,
  onSaved,
  onCancel,
  initialRecord,
  initialUnconfirmed,
  readFailed,
}: TastingCorrectionFormProps & {
  initialRecord: ContextualTasting;
  initialUnconfirmed: boolean;
  readFailed: boolean;
}) {
  const [session] = useState(captureWriteSession);
  const queryClient = useQueryClient();
  const formKey = `tasting-correction:${tastingId}`;
  const [raw, setRaw] = useDraftState(`${formKey}:data`, "");
  const [fallback] = useState(() => ({
    ...initialDraft(initialRecord),
    reviewRequired: initialUnconfirmed,
  }));
  const restored = parseDraft(raw, fallback);
  const draft = restored.value;
  const [baseline, setBaseline] = useState(initialRecord);
  const [confirmedTarget, setConfirmedTarget] = useState<BottleCorrectionContext | null>(null);
  const [confirmedSku, setConfirmedSku] = useState<ProductSkuContext | null>(null);
  const [review, setReview] = useState<{
    record: ContextualTasting;
    target: BottleCorrectionContext | null;
    sku: ProductSkuContext | null;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function saveDraft(value: Draft) {
    setRaw(JSON.stringify(value));
  }
  function edit(patch: Partial<Draft>) {
    if (flight.current || reviewing) return;
    const changed = {
      ...draft,
      ...patch,
      attempt: null,
      reviewRequired:
        draft.reviewRequired ||
        draft.attempt?.outcome === "unknown" ||
        draft.attempt?.outcome === "conflict",
    };
    saveDraft(changed);
    setReview(null);
    setError(null);
  }
  const selectedSkuOption =
    skuOptions?.find((sku) => sku.sku_id === draft.fields.skuId) ??
    (draft.checkedSku?.sku_id === draft.fields.skuId ? draft.checkedSku : undefined) ??
    (baseline.sku_id === draft.fields.skuId ? baseline.context : undefined);
  async function readFreshSku(
    option: ProductSkuContext,
    signal?: AbortSignal,
  ): Promise<ProductSkuContext> {
    session.assertCurrent();
    const product = await productsApi.get(option.product_id, signal);
    session.assertCurrent();
    const sku = product.skus.find((item) => item.id === option.sku_id);
    if (!sku)
      throw new Error(
        "선택한 규격이 삭제되었거나 이 제품에 속하지 않습니다. 다른 규격을 선택해 주세요.",
      );
    return {
      product_id: product.id,
      product_name: product.name,
      vintage: product.vintage,
      age_years: product.age_years,
      abv: product.abv,
      sku_id: sku.id,
      volume_ml: sku.volume_ml,
    };
  }
  const targetSku = useQuery({
    staleTime: 0,
    refetchOnMount: "always",
    queryKey: [
      "products",
      "correction-sku",
      session.userId,
      selectedSkuOption?.product_id,
      draft.fields.skuId,
    ],
    queryFn: ({ signal }) => {
      if (!selectedSkuOption) throw new Error("선택한 규격의 제품을 확인할 수 없습니다.");
      return readFreshSku(selectedSkuOption, signal);
    },
    enabled:
      !offline &&
      !draft.fields.bottleId &&
      Boolean(selectedSkuOption) &&
      confirmedSku?.sku_id !== draft.fields.skuId,
    refetchOnWindowFocus: false,
  });
  const skuConfirmed = confirmedSku?.sku_id === draft.fields.skuId;
  const standaloneSku = skuConfirmed
    ? confirmedSku
    : targetSku.data?.sku_id === draft.fields.skuId
      ? targetSku.data
      : null;
  const skuUnavailable =
    !draft.fields.bottleId &&
    (!standaloneSku || (!skuConfirmed && (targetSku.isFetching || targetSku.isError)));
  const skuChanged =
    !draft.fields.bottleId &&
    standaloneSku &&
    (!draft.checkedSku || skuStamp(draft.checkedSku) !== skuStamp(standaloneSku));
  const target = useQuery({
    staleTime: 0,
    refetchOnMount: "always",
    queryKey: ["bottles", "correction", session.userId, draft.fields.bottleId],
    queryFn: async ({ signal }) => {
      session.assertCurrent();
      const result = await bottlesApi.correctionContext(draft.fields.bottleId, signal);
      session.assertCurrent();
      return result;
    },
    enabled:
      !offline &&
      Boolean(draft.fields.bottleId) &&
      draft.fields.bottleId !== baseline.bottle_id &&
      confirmedTarget?.bottle.id !== draft.fields.bottleId,
    refetchOnWindowFocus: false,
  });
  const source = sourceContext(baseline);
  const destination =
    draft.fields.bottleId === baseline.bottle_id
      ? source
      : confirmedTarget?.bottle.id === draft.fields.bottleId
        ? confirmedTarget
        : target.data?.bottle.id === draft.fields.bottleId
          ? target.data
          : null;
  const affected = [
    ...new Map(
      [source, destination]
        .filter((item): item is BottleCorrectionContext => item !== null)
        .map((item) => [item.bottle.id, item]),
    ).values(),
  ];
  const affectedIds = [
    tastingId,
    baseline.sku_id,
    ...affected.flatMap((item) => [
      item.bottle.id,
      item.purchase.id,
      item.context.sku_id,
      item.context.product_id,
    ]),
    draft.fields.skuId,
  ];
  const newTargetGuard =
    destination &&
    !target.isFetching &&
    !target.isError &&
    target.isFetchedAfterMount &&
    !draft.checkedBottles.some((guard) => guard.id === destination.bottle.id)
      ? { id: destination.bottle.id, revision: destination.bottle.revision }
      : null;
  useEffect(() => {
    if (!newTargetGuard || !raw) return;
    setRaw(JSON.stringify({ ...draft, checkedBottles: [...draft.checkedBottles, newTargetGuard] }));
  }, [newTargetGuard, raw, draft, setRaw]);
  const changedSinceDraft =
    draft.checkedVersion !== baseline.updated_at ||
    affected.some((item) => {
      const guard = draft.checkedBottles.find((entry) => entry.id === item.bottle.id);
      return guard !== undefined && guard.revision !== item.bottle.revision;
    });
  const block = useLiveQuery(async () => {
    try {
      return await getCorrectionBlockReason(session, affectedIds);
    } catch {
      return "관련 기록의 동기화 상태를 확인하지 못했습니다. 입력은 유지됩니다.";
    }
  }, [session, JSON.stringify(affectedIds)]);
  const attachments = useQuery({
    queryKey: ["tastings", tastingId, "attachments", session.userId],
    queryFn: ({ signal }) => tastingsApi.attachments(tastingId, signal),
    enabled: !offline,
  });
  const needsTarget =
    Boolean(draft.fields.bottleId) && draft.fields.bottleId !== baseline.bottle_id;
  const targetConfirmed = confirmedTarget?.bottle.id === draft.fields.bottleId;
  const targetUnavailable =
    Boolean(draft.fields.bottleId) &&
    (!destination || (needsTarget && !targetConfirmed && (target.isFetching || target.isError)));
  const incomplete = targetUnavailable || skuUnavailable;
  const signature = JSON.stringify({
    fields: draft.fields,
    mode: draft.mode,
    finals: draft.finals,
  });
  const retry =
    draft.attempt?.signature === signature && draft.attempt.outcome === "unknown"
      ? draft.attempt
      : null;
  const busy = pending || reviewing;
  const blocked =
    offline ||
    readFailed ||
    incomplete ||
    block === undefined ||
    Boolean(block) ||
    Boolean(newTargetGuard) ||
    (!retry && (changedSinceDraft || Boolean(skuChanged))) ||
    draft.reviewRequired ||
    restored.invalid;
  const mutation = useSessionMutation({
    // Never defer an online correction silently until reconnection.
    networkMode: "always",
    mutationFn: (input: TastingCorrectionInput, currentSession) =>
      submitTastingCorrection(tastingId, input, currentSession),
  });
  async function refreshForReview() {
    if (flight.current || reviewing || offline) return;
    setReviewing(true);
    setError(null);
    setReview(null);
    saveDraft({ ...draft, reviewRequired: true });
    const selectedId = draft.fields.bottleId;
    try {
      session.assertCurrent();
      const [record, selected, sku] = await Promise.all([
        tastingsApi.get(tastingId),
        selectedId ? bottlesApi.correctionContext(selectedId) : Promise.resolve(null),
        selectedId
          ? Promise.resolve(null)
          : selectedSkuOption
            ? readFreshSku(selectedSkuOption)
            : Promise.reject(new Error("목표 규격을 선택해 주세요.")),
      ]);
      session.assertCurrent();
      if (mounted.current) setReview({ record, target: selected, sku });
    } catch (cause) {
      if (mounted.current && session.isCurrent())
        setError(cause instanceof Error ? cause.message : "최신 상태를 확인하지 못했습니다.");
    } finally {
      if (mounted.current && session.isCurrent()) setReviewing(false);
    }
  }
  function confirmReview() {
    if (!review || flight.current) return;
    setBaseline(review.record);
    setConfirmedTarget(review.target);
    setConfirmedSku(review.sku);
    setReview(null);
    saveDraft({
      ...draft,
      attempt: null,
      reviewRequired: false,
      checkedVersion: review.record.updated_at,
      checkedSku: review.sku,
      checkedBottles: [
        ...new Map(
          [sourceContext(review.record), review.target]
            .filter((item): item is BottleCorrectionContext => item !== null)
            .map((item) => [
              item.bottle.id,
              { id: item.bottle.id, revision: item.bottle.revision },
            ]),
        ).values(),
      ],
    });
    setError(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.current || busy || blocked) return;
    const poured = draft.fields.pouredMl === "" ? null : Number(draft.fields.pouredMl);
    const rating = draft.fields.rating === "" ? null : Number(draft.fields.rating);
    if (
      (poured !== null && (!Number.isInteger(poured) || poured <= 0)) ||
      (rating !== null &&
        (!Number.isFinite(rating) || rating < 0 || rating > 6 || !Number.isInteger(rating * 2)))
    ) {
      setError("시음량은 양의 정수, 평점은 0~6점의 0.5 단위로 입력하세요.");
      return;
    }
    const currentSession = captureWriteSession();
    const fields = draft.fields;
    const input: TastingCorrectionInput = retry?.input ?? {
      request_id: crypto.randomUUID(),
      expected_updated_at: baseline.updated_at,
      changes: {
        bottle_id: fields.bottleId || null,
        sku_id: destination?.context.sku_id ?? fields.skuId,
        tasted_on: fields.tastedOn,
        poured_ml: poured,
        rating: fields.rating || null,
        nose: fields.nose || null,
        palate: fields.palate || null,
        finish: fields.finish || null,
        note: fields.note || null,
        place: fields.place || null,
        companions: fields.companions || null,
      },
      expected_bottles: affected
        .map((item) => ({ id: item.bottle.id, revision: item.bottle.revision }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      remaining_mode: draft.mode,
      final_bottles:
        draft.mode === "set_final"
          ? affected
              .map(
                (item) =>
                  draft.finals.find((final) => final.id === item.bottle.id) ??
                  finalStateOf(item.bottle),
              )
              .sort((a, b) => a.id.localeCompare(b.id))
          : [],
      ...(!fields.bottleId && standaloneSku
        ? { target_sku_expected_volume_ml: standaloneSku.volume_ml }
        : {}),
    };
    const submitted: Draft = { ...draft, attempt: { signature, input, outcome: "unknown" } };
    flight.current = true;
    setPending(true);
    onSavingChange(true);
    setError(null);
    // Persist the frozen request before network I/O, then snapshot exactly that draft version.
    flushSync(() => saveDraft(submitted));
    const captured = captureFormDraft(formKey);
    try {
      const result = await mutation.mutateAsync(input);
      currentSession.assertCurrent();
      const cleared = clearSubmittedDraft(captured);
      await Promise.all(
        ["tastings", "bottles", "products", "stats"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      if (mounted.current && currentSession.isCurrent() && cleared) onSaved(result);
    } catch (cause) {
      if (mounted.current && currentSession.isCurrent()) {
        const conflict = cause instanceof ApiError && cause.status === 409;
        const rejected =
          cause instanceof ApiError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          cause.status !== 408 &&
          !conflict;
        saveDraft({
          ...submitted,
          reviewRequired: conflict || submitted.reviewRequired,
          attempt: {
            signature,
            input,
            outcome: conflict ? "conflict" : rejected ? "rejected" : "unknown",
          },
        });
        setError(
          conflict
            ? "기록 또는 병이 다른 곳에서 변경되었습니다. 입력은 유지했습니다. 최신 상태를 확인하고 다시 승인하세요."
            : cause instanceof Error
              ? cause.message
              : "정정을 저장하지 못했습니다. 같은 요청으로 다시 확인할 수 있습니다.",
        );
      }
    } finally {
      flight.current = false;
      if (mounted.current && currentSession.isCurrent()) {
        setPending(false);
        onSavingChange(false);
      }
    }
  }
  const purchaseIds = [...new Set((bottleOptions ?? []).map((option) => option.purchase.id))];
  const options = [
    ...new Map(
      [...(bottleOptions ?? []), ...(source ? [source] : [])].map((option) => [
        option.bottle.id,
        option,
      ]),
    ).values(),
  ];
  return (
    <form className="panel tasting-correction-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy}>
        <legend>기록 내용과 현재 병 상태를 따로 확인합니다</legend>
        <DraftRecoveryButton form={formKey} />
        <p>
          {label(baseline.context)} · 시음 {baseline.tasted_on}
        </p>
        <TastingFields
          mode="summary"
          values={draft.fields}
          onChange={(patch) => edit({ fields: { ...draft.fields, ...patch } })}
        />
        <p className="muted">평점과 메모를 고쳐도 병의 현재 잔량은 그대로 유지됩니다.</p>
        <details className="tasting-correction-advanced">
          <summary>날짜·양·대상 병·현재 잔량 정정</summary>
          <TastingFields
            mode="advanced"
            values={draft.fields}
            onChange={(patch) => edit({ fields: { ...draft.fields, ...patch } })}
          />
          <label>
            정정할 대상 병
            <select
              aria-label="정정할 대상 병"
              value={draft.fields.bottleId}
              onChange={(event) => {
                setConfirmedTarget(null);
                setConfirmedSku(null);
                const option = options.find((item) => item.bottle.id === event.target.value);
                edit({
                  checkedSku: event.target.value ? null : (selectedSkuOption ?? null),
                  fields: {
                    ...draft.fields,
                    bottleId: event.target.value,
                    skuId: option?.context.sku_id ?? draft.fields.skuId,
                  },
                });
              }}
            >
              <option value="">병 연결 없이 규격에 기록</option>
              {draft.fields.bottleId &&
              !options.some((option) => option.bottle.id === draft.fields.bottleId) ? (
                <option value={draft.fields.bottleId}>
                  이전에 선택한 병 — 현재 상태 확인 필요
                </option>
              ) : null}
              {options
                .filter((option) => !option.bottle.deleted_at)
                .map((option) => (
                  <option key={option.bottle.id} value={option.bottle.id}>
                    {label(option.context)} · {option.bottle.label_no}번 병 ·{" "}
                    {purchaseReference(option.purchase.id, purchaseIds)} ·{" "}
                    {option.purchase.purchased_on ?? "구매일 미기록"} ·{" "}
                    {option.purchase.vendor_name ?? "구매처 미기록"} ·{" "}
                    {STATUS_LABELS[option.bottle.status]}
                  </option>
                ))}
            </select>
          </label>
          {!draft.fields.bottleId ? (
            <label>
              병 없는 시음의 규격
              <select
                aria-label="병 없는 시음의 규격"
                value={draft.fields.skuId}
                onChange={(event) => {
                  setConfirmedSku(null);
                  edit({
                    fields: { ...draft.fields, skuId: event.target.value },
                    checkedSku:
                      skuOptions?.find((sku) => sku.sku_id === event.target.value) ?? null,
                  });
                }}
              >
                <option value="">규격을 선택하세요</option>
                {skuOptions?.map((sku) => (
                  <option key={sku.sku_id} value={sku.sku_id}>
                    {label(standaloneSku?.sku_id === sku.sku_id ? standaloneSku : sku)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!draft.fields.bottleId && standaloneSku ? (
            <p>확인한 목표 규격: {label(standaloneSku)}</p>
          ) : null}
          {skuUnavailable && !offline ? (
            <p role="alert">
              목표 규격의 최신 용량·판본을 확인 중이거나 조회하지 못했습니다. 확인 전에는 저장할 수
              없습니다.
            </p>
          ) : null}
          {!draft.fields.bottleId && !skuConfirmed && targetSku.isError && !offline ? (
            <>
              <p role="alert">{targetSku.error.message}</p>
              <button type="button" onClick={() => void targetSku.refetch()}>
                목표 규격 다시 확인
              </button>
            </>
          ) : null}
          {skuChanged && !retry ? (
            <p role="alert">
              선택한 규격의 용량 또는 판본 정보가 바뀌었습니다. 최신 상태를 다시 확인하고 승인해
              주세요.
            </p>
          ) : null}
          {bottleOptions === undefined || (!draft.fields.bottleId && skuOptions === undefined) ? (
            <output>선택할 병과 규격을 불러오는 중…</output>
          ) : null}
          {targetUnavailable && !offline ? (
            <p role="alert">
              대상 병의 최신 상태를 확인 중이거나 조회하지 못했습니다. 확인 전에는 저장할 수
              없습니다.
            </p>
          ) : null}
          {needsTarget && !targetConfirmed && target.isError && !offline ? (
            <button type="button" onClick={() => void target.refetch()}>
              대상 병 다시 확인
            </button>
          ) : null}
          <fieldset>
            <legend>현재 병 상태·잔량</legend>
            <label>
              <input
                type="radio"
                name={`remaining-mode-${tastingId}`}
                checked={draft.mode === "preserve"}
                onChange={() => edit({ mode: "preserve" })}
              />
              기록만 정정하고 현재 상태·잔량 유지
            </label>
            <label>
              <input
                type="radio"
                name={`remaining-mode-${tastingId}`}
                checked={draft.mode === "set_final"}
                onChange={() => edit({ mode: "set_final" })}
              />
              명시한 최종 상태·잔량으로 함께 정정
            </label>
            <p className="muted">
              시음량 차이를 자동으로 더하거나 빼지 않습니다. 원래 병과 대상 병을 각각 확인하세요.
            </p>
            {affected.map((item) =>
              draft.mode === "set_final" ? (
                <FinalBottleStateFields
                  key={item.bottle.id}
                  current={item.bottle}
                  value={
                    draft.finals.find((final) => final.id === item.bottle.id) ??
                    finalStateOf(item.bottle)
                  }
                  volumeMl={item.context.volume_ml}
                  contextLabel={`${item.bottle.id === baseline.bottle_id ? "원래 병" : "대상 병"} · ${label(item.context)} · ${item.bottle.label_no}번 병`}
                  disabled={busy}
                  onChange={(next) =>
                    edit({
                      finals: [...draft.finals.filter((final) => final.id !== next.id), next].sort(
                        (a, b) => a.id.localeCompare(b.id),
                      ),
                    })
                  }
                />
              ) : (
                <p key={item.bottle.id}>
                  {item.bottle.id === baseline.bottle_id ? "원래 병" : "대상 병"} ·{" "}
                  {label(item.context)} · {item.bottle.label_no}번 병:{" "}
                  {STATUS_LABELS[item.bottle.status]} ·{" "}
                  {item.bottle.remaining_ml === null
                    ? item.bottle.status === "unopened"
                      ? "미개봉 전량"
                      : "잔량 미기록"
                    : `${item.bottle.remaining_ml}ml`}{" "}
                  → 그대로 유지
                </p>
              ),
            )}
          </fieldset>
        </details>
        {offline ? (
          <p role="alert">
            수정 저장은 온라인에서 할 수 있습니다. 작성 중인 입력은 이 기기에 유지됩니다.
          </p>
        ) : null}
        {readFailed ? (
          <p role="alert">
            최신 기록을 확인 중이거나 조회하지 못했습니다. 확인 전에는 저장할 수 없습니다.
          </p>
        ) : null}
        {block ? <p role="alert">{block}</p> : null}
        {restored.invalid ? (
          <p role="alert">
            저장된 정정 초안의 형식을 확인할 수 없습니다. 기존 초안은 지우지 않았습니다. 내용을
            확인하고 다시 입력하세요.
          </p>
        ) : null}
        {retry ? (
          <p className="muted">
            이전 제출 결과를 아직 확인하지 못했습니다. 다시 저장하면 같은 요청을 확인합니다. 입력을
            바꾸면 최신 상태를 다시 확인해야 합니다.
          </p>
        ) : null}
        {draft.reviewRequired || (!retry && changedSinceDraft) ? (
          <p role="alert">
            최신 기록과 병 상태를 확인한 뒤 다시 승인해야 합니다. 입력은 유지됩니다.
          </p>
        ) : null}
        <button type="button" disabled={offline || busy} onClick={() => void refreshForReview()}>
          최신 상태 다시 확인
        </button>
        {review ? (
          <section className="notice" aria-label="다시 확인한 최신 상태">
            {review.sku ? <p>정정할 목표 규격: {label(review.sku)}</p> : null}
            <p>
              최신 기록: {label(review.record.context)} · {review.record.tasted_on} ·{" "}
              {review.record.poured_ml ?? "미기록"}ml · 평점 {review.record.rating ?? "없음"}
            </p>
            <p>
              향 {review.record.nose ?? "없음"} · 맛 {review.record.palate ?? "없음"} · 피니시{" "}
              {review.record.finish ?? "없음"}
            </p>
            <p>
              메모 {review.record.note ?? "없음"} · 장소 {review.record.place ?? "없음"} · 동석자{" "}
              {review.record.companions ?? "없음"}
            </p>
            {[sourceContext(review.record), review.target]
              .filter((item): item is BottleCorrectionContext => item !== null)
              .map((item, index) => (
                <p key={`${item.bottle.id}:${index}`}>
                  {index === 0 ? "원래 병" : "대상 병"} {label(item.context)} ·{" "}
                  {STATUS_LABELS[item.bottle.status]} · 잔량 {item.bottle.remaining_ml ?? "미기록"}
                  ml
                </p>
              ))}
            <p>
              위 최신 상태를 기준으로 지금 작성한 정정 내용을 적용합니다. 작성한 입력은 바뀌지
              않습니다.
            </p>
            <button type="button" onClick={confirmReview}>
              이 최신 상태로 정정 다시 확인
            </button>
          </section>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="button-row">
          <button type="submit" className="primary" disabled={busy || blocked}>
            {pending ? "수정 저장 중…" : retry ? "같은 요청 다시 확인" : "수정 저장"}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            취소
          </button>
        </div>
      </fieldset>
      <details>
        <summary>시음 첨부</summary>
        {offline ? (
          <p>첨부 목록은 온라인에서 확인할 수 있습니다. 정정해도 기존 첨부 연결은 유지됩니다.</p>
        ) : attachments.isPending ? (
          <output>첨부를 불러오는 중…</output>
        ) : attachments.isError ? (
          <p role="alert">첨부 목록을 확인하지 못했습니다. 첨부를 삭제하거나 바꾸지 않습니다.</p>
        ) : (
          <ul>
            {attachments.data?.map((attachment) => (
              <li key={attachment.id}>
                {attachment.original_filename ?? attachment.caption ?? "첨부 이미지"}
                {attachment.caption ? ` · ${attachment.caption}` : ""}
              </li>
            ))}
          </ul>
        )}
      </details>
      <HistoryDetails
        title="이 시음의 정정 이력"
        queryKey={["tastings", tastingId, "history", session.userId]}
        load={(signal) => tastingsApi.history(tastingId, signal)}
        online={!offline}
      />
    </form>
  );
}
