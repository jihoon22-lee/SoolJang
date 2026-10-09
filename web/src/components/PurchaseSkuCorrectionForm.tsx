import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ApiError, productsApi, purchasesApi } from "@/api/client";
import type {
  FinalBottleState,
  PurchaseCorrectionContext,
  PurchaseSkuCorrectionInput,
} from "@/api/types";
import { FinalBottleStateFields, finalStateOf } from "@/components/FinalBottleStateFields";
import { HistoryDetails } from "@/components/HistoryList";
import { productEdition } from "@/components/productDisplay";
import { getCorrectionBlockReason, submitPurchaseSkuCorrection } from "@/sync/corrections";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { captureFormDraft, clearSubmittedDraft, useDraftState } from "@/sync/drafts";
import { captureWriteSession } from "@/sync/writeSession";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
const states = new Set(["unopened", "open", "finished", "gifted", "sold"]);
function isFinalState(value: unknown): value is FinalBottleState {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    states.has(String(value.status)) &&
    (value.remaining_ml === null ||
      (Number.isInteger(value.remaining_ml) && Number(value.remaining_ml) >= 0)) &&
    nullableText(value.opened_on) &&
    nullableText(value.finished_on)
  );
}
function parseFinals(raw: string): FinalBottleState[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) &&
      value.every(isFinalState) &&
      new Set(value.map((row) => row.id)).size === value.length
      ? value
      : null;
  } catch {
    return null;
  }
}
function parseSubmission(
  raw: string,
  purchaseId: string,
): {
  signature: string;
  input: PurchaseSkuCorrectionInput;
  outcome: "unknown" | "conflict" | "rejected";
} | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isObject(value) ||
      value.purchaseId !== purchaseId ||
      typeof value.signature !== "string" ||
      !["unknown", "conflict", "rejected"].includes(String(value.outcome)) ||
      !isObject(value.input)
    )
      return null;
    const input = value.input;
    if (
      typeof input.request_id !== "string" ||
      !input.request_id ||
      typeof input.expected_updated_at !== "string" ||
      typeof input.target_sku_id !== "string" ||
      !Number.isInteger(input.target_sku_expected_volume_ml) ||
      Number(input.target_sku_expected_volume_ml) <= 0 ||
      !Array.isArray(input.expected_bottles) ||
      !input.expected_bottles.every(
        (row) => isObject(row) && typeof row.id === "string" && typeof row.revision === "string",
      ) ||
      !Array.isArray(input.expected_tastings) ||
      !input.expected_tastings.every(
        (row) => isObject(row) && typeof row.id === "string" && typeof row.updated_at === "string",
      ) ||
      !Array.isArray(input.final_bottles) ||
      !input.final_bottles.every(isFinalState)
    )
      return null;
    return {
      signature: value.signature,
      input: input as unknown as PurchaseSkuCorrectionInput,
      outcome: value.outcome as "unknown" | "conflict" | "rejected",
    };
  } catch {
    return null;
  }
}

function contextStamp(
  context: PurchaseCorrectionContext,
  skus: readonly { id: string; volume_ml: number }[],
): string {
  return JSON.stringify([
    context.purchase.updated_at,
    context.bottles.map(({ id, revision }) => [id, revision]),
    context.tastings.map(({ id, updated_at }) => [id, updated_at]),
    skus.map(({ id, volume_ml }) => [id, volume_ml]),
  ]);
}

export function PurchaseSkuCorrectionForm({
  purchaseId,
  offline,
  onSavingChange,
  onSaved,
  onCancel,
}: {
  purchaseId: string;
  offline: boolean;
  onSavingChange: (saving: boolean) => void;
  onSaved: (result: PurchaseCorrectionContext) => void;
  onCancel: () => void;
}) {
  const prefix = `purchase-correction:${purchaseId}`;
  const [targetSkuId, setTargetSkuId] = useDraftState(`${prefix}:target`, "");
  const [finalsJson, setFinalsJson] = useDraftState(`${prefix}:finals`, "[]");
  const [submissionJson, setSubmissionJson] = useDraftState(`${prefix}:submission`, "");
  const [baseStamp, setBaseStamp] = useDraftState(`${prefix}:base`, "");
  const [session] = useState(captureWriteSession);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true);
  const flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: ["purchase-correction-context", session.userId, purchaseId],
    queryFn: async ({ signal }) => {
      session.assertCurrent();
      const context = await purchasesApi.correctionContext(purchaseId, signal);
      const product = await productsApi.get(context.context.product_id, signal);
      session.assertCurrent();
      return { context, product };
    },
    enabled: !offline,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = query.data;
  const observedSnapshot = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const stamp = contextStamp(data.context, data.product.skus);
    const observation = JSON.stringify([stamp, baseStamp]);
    if (observedSnapshot.current === observation) return;
    observedSnapshot.current = observation;
    setAcknowledged(false);
    if (baseStamp && stamp !== baseStamp) setNeedsRefresh(true);
    else if (!baseStamp) setBaseStamp(stamp);
  }, [data, baseStamp, setBaseStamp]);
  const target = data?.product.skus.find((sku) => sku.id === targetSkuId);
  const finals = parseFinals(finalsJson);
  const signature = JSON.stringify({ targetSkuId, finals });
  const previous = parseSubmission(submissionJson, purchaseId);
  const retry =
    previous?.signature === signature && previous.outcome === "unknown" ? previous.input : null;
  const detachedFinals =
    finals?.filter(
      (final) => data && !data.context.bottles.some((bottle) => bottle.id === final.id),
    ) ?? [];
  const affectedIds = [
    purchaseId,
    targetSkuId,
    ...(data?.context.bottles.map((bottle) => bottle.id) ?? []),
  ].filter(Boolean);
  const blockReason = useLiveQuery(
    () => getCorrectionBlockReason(session, affectedIds),
    [session, affectedIds.join(",")],
  );
  const needsFinal = data?.context.bottles.some(
    (bottle) =>
      target &&
      bottle.remaining_ml !== null &&
      bottle.remaining_ml > target.volume_ml &&
      !finals?.some((state) => state.id === bottle.id),
  );
  const unavailable =
    offline ||
    !data ||
    query.isFetching ||
    query.isError ||
    (needsRefresh && !retry) ||
    (detachedFinals.length > 0 && !retry) ||
    !target ||
    !finals ||
    Boolean(needsFinal) ||
    blockReason !== null ||
    (targetSkuId === data.context.purchase.sku_id && !retry);

  function updateFinals(next: FinalBottleState[]) {
    setFinalsJson(JSON.stringify(next));
    setAcknowledged(false);
  }

  async function save() {
    if (flight.current || unavailable || !acknowledged || !data || !target || !finals) return;
    flight.current = true;
    setPending(true);
    onSavingChange(true);
    setError(null);
    const input: PurchaseSkuCorrectionInput = retry ?? {
      request_id: crypto.randomUUID(),
      expected_updated_at: data.context.purchase.updated_at,
      target_sku_id: target.id,
      target_sku_expected_volume_ml: target.volume_ml,
      expected_bottles: data.context.bottles.map(({ id, revision }) => ({ id, revision })),
      expected_tastings: data.context.tastings.map(({ id, updated_at }) => ({ id, updated_at })),
      final_bottles: structuredClone(finals),
    };
    flushSync(() =>
      setSubmissionJson(JSON.stringify({ purchaseId, signature, input, outcome: "unknown" })),
    );
    const draft = captureFormDraft(prefix);
    try {
      const result = await submitPurchaseSkuCorrection(purchaseId, input, session);
      const cleared = clearSubmittedDraft(draft);
      if (!mounted.current || !session.isCurrent()) return;
      void queryClient.invalidateQueries();
      if (cleared) onSaved(result);
      else setError("저장한 내용과 다른 입력이 남아 있습니다. 최신 상태를 확인해 주세요.");
    } catch (cause) {
      if (!mounted.current || !session.isCurrent()) return;
      setError(cause instanceof Error ? cause.message : "구매 규격 정정에 실패했습니다.");
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408
      )
        setSubmissionJson(
          JSON.stringify({
            purchaseId,
            signature,
            input,
            outcome: cause.status === 409 ? "conflict" : "rejected",
          }),
        );
      if (cause instanceof ApiError && cause.status === 409) setNeedsRefresh(true);
    } finally {
      flight.current = false;
      if (mounted.current && session.isCurrent()) {
        setPending(false);
        onSavingChange(false);
      }
    }
  }

  return (
    <form
      className="sheet correction-form"
      aria-label="구매 규격 정정"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>구매 규격 정정</h3>
      <fieldset disabled={pending} className="correction-fields">
        <DraftRecoveryButton form={prefix} />
        <p>
          이 구매의 병과 연결된 시음은 같은 ID로 유지합니다. 다른 구매의 규격은 바꾸지 않습니다.
        </p>
        {offline ? (
          <p className="notice">
            정정 저장은 온라인에서 가능합니다. 작성한 입력은 이 기기에 유지됩니다.
          </p>
        ) : null}
        {query.isPending && !offline ? <output>현재 구매와 병 상태를 확인하는 중…</output> : null}
        {query.isError ? (
          <p role="alert" className="alert">
            현재 상태를 불러오지 못했습니다. 입력을 유지했습니다.
          </p>
        ) : null}
        {data ? (
          <>
            <p>
              <strong>{data.context.context.product_name}</strong> ·{" "}
              {productEdition(data.context.context)} · 현재 {data.context.context.volume_ml}ml
            </p>
            <p className="text-sm">
              구매일 {data.context.purchase.purchased_on ?? "미기록"} ·{" "}
              {data.context.purchase.vendor_name ?? "구매처 미기록"} · 보존할 병{" "}
              {data.context.bottles.length}개 · 연결 시음 {data.context.tastings.length}개
            </p>
            <label className="field">
              바꿀 규격
              <select
                aria-label="바꿀 규격"
                value={targetSkuId}
                onChange={(event) => {
                  setTargetSkuId(event.target.value);
                  setAcknowledged(false);
                }}
              >
                <option value="">목표 용량을 선택하세요</option>
                {data.product.skus.map((sku) => (
                  <option key={sku.id} value={sku.id}>
                    {sku.volume_ml}ml{sku.id === data.context.purchase.sku_id ? " (현재 규격)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {targetSkuId && !target ? (
              <p className="alert" role="alert">
                선택한 규격을 사용할 수 없습니다. 다른 규격을 선택해 주세요.
              </p>
            ) : null}
            {target ? (
              <>
                <p className="notice">
                  {data.context.context.volume_ml}ml → {target.volume_ml}ml. 미개봉 병의 잔량이 비어
                  있으면 새 용량 전량({target.volume_ml}ml)으로 해석합니다. 개봉 병의 미기록 잔량은
                  그대로입니다.
                </p>
                {data.context.bottles.map((bottle) => {
                  const final = finals?.find((state) => state.id === bottle.id);
                  const exceeds =
                    bottle.remaining_ml !== null && bottle.remaining_ml > target.volume_ml;
                  return (
                    <div className="correction-bottle" key={bottle.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(final)}
                          onChange={(event) =>
                            updateFinals(
                              event.target.checked
                                ? [...(finals ?? []), finalStateOf(bottle)]
                                : (finals ?? []).filter((state) => state.id !== bottle.id),
                            )
                          }
                        />{" "}
                        {bottle.label_no}번 병의 최종 상태·잔량도 지정
                        {bottle.deleted_at ? " (삭제 기록)" : ""}
                      </label>
                      {exceeds && !final ? (
                        <p className="alert" role="alert">
                          현재 {bottle.remaining_ml}ml가 새 용량보다 큽니다. 최종 잔량을 직접 지정해
                          주세요.
                        </p>
                      ) : null}
                      {final ? (
                        <FinalBottleStateFields
                          current={bottle}
                          value={final}
                          volumeMl={target.volume_ml}
                          contextLabel={`${bottle.label_no}번 병`}
                          onChange={(value) =>
                            updateFinals(
                              (finals ?? []).map((state) =>
                                state.id === bottle.id ? value : state,
                              ),
                            )
                          }
                        />
                      ) : (
                        <p className="muted text-sm">
                          현재 잔량{" "}
                          {bottle.remaining_ml === null
                            ? bottle.status === "unopened"
                              ? "미개봉 전량"
                              : "미기록"
                            : `${bottle.remaining_ml}ml`}{" "}
                          유지
                        </p>
                      )}
                    </div>
                  );
                })}
              </>
            ) : null}
          </>
        ) : null}
        {detachedFinals.map((final) => (
          <div key={final.id} className="notice" role="alert">
            <p>
              이 구매에서 이동되었거나 사용할 수 없는 병의 최종 상태 초안이 남아 있습니다. 병 참조{" "}
              {final.id.slice(-8)} · 잔량 {final.remaining_ml ?? "미기록"}ml
            </p>
            <button
              type="button"
              onClick={() => updateFinals((finals ?? []).filter((state) => state.id !== final.id))}
            >
              이동한 병의 최종 상태 입력 해제
            </button>
          </div>
        ))}
        {finals === null ? (
          <p role="alert" className="alert">
            병 상태 초안을 읽을 수 없습니다.{" "}
            <button type="button" onClick={() => updateFinals([])}>
              병 상태 입력 다시 시작
            </button>
          </p>
        ) : null}
        {blockReason ? (
          <p role="alert" className="notice">
            {blockReason}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="alert">
            {error}
          </p>
        ) : null}
        {needsRefresh ? (
          <p className="notice">
            다른 변경이 있습니다. 최신 상태를 확인한 뒤 입력을 다시 검토해 주세요.
          </p>
        ) : null}
        <button
          type="button"
          disabled={offline || query.isFetching}
          onClick={() => {
            setAcknowledged(false);
            void query.refetch().then((result) => {
              if (result.isSuccess && mounted.current && session.isCurrent()) {
                setBaseStamp(contextStamp(result.data.context, result.data.product.skus));
                setNeedsRefresh(false);
                setSubmissionJson("");
                setError(null);
              }
            });
          }}
        >
          {query.isFetching ? "확인 중…" : "최신 상태 다시 확인"}
        </button>
        <label className="correction-confirm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />{" "}
          위 구매의 목표 용량과 병별 최종 상태를 확인했습니다.
        </label>
        <HistoryDetails
          title="이 구매의 수정 이력"
          queryKey={["purchases", purchaseId, "history"]}
          load={(signal) => purchasesApi.history(purchaseId, signal)}
          online={!offline}
        />
        <div className="button-row">
          <button className="primary" type="submit" disabled={unavailable || !acknowledged}>
            {pending ? "정정 저장 중…" : retry ? "같은 정정 다시 저장" : "구매 규격 정정 저장"}
          </button>
          <button type="button" onClick={onCancel}>
            닫기
          </button>
        </div>
      </fieldset>
    </form>
  );
}
