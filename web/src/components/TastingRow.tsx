import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, tastingsApi } from "@/api/client";
import type { TastingLifecycleInput } from "@/api/tastingLifecycle";
import type { ContextualTasting } from "@/api/types";
import { productEdition } from "@/components/productDisplay";
import { useToast } from "@/components/Toast";
import { formatVolume } from "@/format";
import { changeTastingVisibility, isNewerTastingVersion } from "@/sync/tastingLifecycle";
import { captureWriteSession } from "@/sync/writeSession";
import "@/tasting-quality.css";

export interface TastingRowProps {
  item: ContextualTasting;
  offline: boolean;
  onCorrect: (item: ContextualTasting) => void;
  onSelectTasting?: ((item: ContextualTasting) => void) | undefined;
  onDeleted?: ((item: ContextualTasting) => void) | undefined;
  disabled?: boolean | undefined;
  contextLabel?: string | undefined;
}

/** The same record actions are available from home, product history and bottle history. */
export function TastingRow({
  item,
  offline,
  onCorrect,
  onSelectTasting,
  onDeleted,
  disabled = false,
  contextLabel,
}: TastingRowProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [session] = useState(captureWriteSession);
  const [confirmation, setConfirmation] = useState<ContextualTasting | null>(null);
  const [request, setRequest] = useState<TastingLifecycleInput | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  const latestDeleted = useRef(onDeleted);
  latestDeleted.current = onDeleted;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [restored, setRestored] = useState<ContextualTasting | null>(null);
  const displayed =
    restored?.id === item.id && isNewerTastingVersion(restored.updated_at, item.updated_at)
      ? restored
      : item;
  const label =
    contextLabel ??
    [
      displayed.context.product_name,
      productEdition(displayed.context),
      formatVolume(displayed.context.volume_ml),
      displayed.bottle ? `${displayed.bottle.label_no}번 병` : "병 연결 없음",
      displayed.purchase?.purchased_on,
      displayed.purchase?.vendor_name,
    ]
      .filter(Boolean)
      .join(" · ");
  const refresh = () => {
    if (!session.isCurrent()) return;
    for (const key of ["tastings", "bottles", "products", "stats"])
      void queryClient.invalidateQueries({ queryKey: [key] });
  };
  async function remove() {
    if (!confirmation || !request || working.current || conflict) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await changeTastingVisibility(
        confirmation.id,
        request,
        "delete",
        session,
        () => {
          if (mounted.current) latestDeleted.current?.(confirmation);
        },
      );
      session.assertCurrent();
      if (result.superseded) {
        refresh();
        setConflict(true);
        setError("이 요청 이후 기록이 다시 변경되었습니다. 최신 기록을 확인하세요.");
        return;
      }
      setDeleted(true);
      setConfirmation(null);
      refresh();
      const recovery = { request_id: crypto.randomUUID(), expected_updated_at: result.updated_at };
      const restore = async () => {
        try {
          const recovered = await changeTastingVisibility(
            confirmation.id,
            recovery,
            "restore",
            session,
          );
          session.assertCurrent();
          if (recovered.superseded) {
            refresh();
            toast.show({
              message: "복구 요청 이후 기록이 다시 변경되었습니다. 최신 기록을 확인하세요.",
            });
            return;
          }
          setRestored({ ...confirmation, updated_at: recovered.updated_at });
          setDeleted(false);
          refresh();
          toast.show({ message: "시음 기록을 복구했습니다. 병의 잔량은 바뀌지 않았습니다." });
        } catch (cause) {
          if (!session.isCurrent()) return;
          const retryable = !(
            cause instanceof ApiError && [404, 409, 410, 422].includes(cause.status)
          );
          toast.show({
            message: cause instanceof Error ? cause.message : "기록을 복구하지 못했습니다.",
            tone: "error",
            ...(retryable
              ? { actionLabel: "복구 다시 확인", onAction: restore, durationMs: 60_000 }
              : {}),
          });
        }
      };
      toast.show({
        message:
          "시음 기록을 삭제했습니다. 잔량은 그대로입니다. 30일 안에는 데이터 품질 화면의 최근 삭제한 시음에서도 복구할 수 있습니다.",
        actionLabel: "기록 복구",
        onAction: restore,
        durationMs: 60_000,
      });
    } catch (cause) {
      if (!session.isCurrent()) return;
      setConflict(cause instanceof ApiError && cause.status === 409);
      setError(
        cause instanceof Error
          ? cause.message
          : "삭제 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.",
      );
    } finally {
      working.current = false;
      if (session.isCurrent()) setBusy(false);
    }
  }
  async function reviewLatest() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const latest = await tastingsApi.get(item.id);
      session.assertCurrent();
      setConfirmation(latest);
      setRequest({ request_id: crypto.randomUUID(), expected_updated_at: latest.updated_at });
      setConflict(false);
      setError(null);
    } catch (cause) {
      if (session.isCurrent())
        setError(cause instanceof Error ? cause.message : "최신 기록을 확인하지 못했습니다.");
    } finally {
      working.current = false;
      if (session.isCurrent()) setBusy(false);
    }
  }
  if (deleted) return null;
  return (
    <article className="tasting-record">
      <p className="tasting-record-context">{label}</p>
      <p>
        <time dateTime={displayed.tasted_on}>{displayed.tasted_on}</time> ·{" "}
        {displayed.rating === null ? "평점 없음" : `${displayed.rating}점`}
        {displayed.poured_ml === null ? "" : ` · ${displayed.poured_ml}ml`}
      </p>
      {displayed.note ? <p className="tasting-record-note">{displayed.note}</p> : null}
      {displayed.nose ||
      displayed.palate ||
      displayed.finish ||
      displayed.place ||
      displayed.companions ? (
        <details>
          <summary>시음 상세</summary>
          {displayed.nose ? <p>향: {displayed.nose}</p> : null}
          {displayed.palate ? <p>맛: {displayed.palate}</p> : null}
          {displayed.finish ? <p>피니시: {displayed.finish}</p> : null}
          {displayed.place || displayed.companions ? (
            <p>{[displayed.place, displayed.companions].filter(Boolean).join(" · ")}</p>
          ) : null}
        </details>
      ) : null}
      <div className="button-row">
        {onSelectTasting ? (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => onSelectTasting(displayed)}
          >
            기록 보기
          </button>
        ) : null}
        <button type="button" disabled={disabled || busy} onClick={() => onCorrect(displayed)}>
          수정
        </button>
        <button
          type="button"
          disabled={offline || disabled || busy}
          onClick={() => {
            setConfirmation(displayed);
            setRequest({
              request_id: crypto.randomUUID(),
              expected_updated_at: displayed.updated_at,
            });
            setConflict(false);
            setError(null);
          }}
        >
          삭제
        </button>
      </div>
      {confirmation ? (
        <section className="tasting-delete-confirm" aria-label="시음 삭제 확인">
          <strong>이 시음 기록을 삭제할까요?</strong>
          <p>
            {confirmation.context.product_name} · {confirmation.tasted_on} ·{" "}
            {confirmation.rating === null ? "평점 없음" : `${confirmation.rating}점`} ·{" "}
            {confirmation.poured_ml === null ? "따른 양 미기록" : `${confirmation.poured_ml}ml`}
          </p>
          {confirmation.note ? <p>{confirmation.note}</p> : null}
          <p>병의 잔량은 바뀌지 않습니다. 삭제 후 기록 복구도 잔량을 바꾸지 않습니다.</p>
          <p className="muted">
            양을 잘못 적었다면 수정에서 현재 잔량을 직접 정정하세요. 다시 입력하면 새 시음으로 추가
            차감됩니다.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          {conflict ? (
            <button type="button" disabled={busy || offline} onClick={() => void reviewLatest()}>
              최신 기록 다시 확인
            </button>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              disabled={busy || offline || conflict}
              onClick={() => void remove()}
            >
              {busy ? "확인 중…" : "시음 기록 삭제"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                onCorrect(confirmation);
              }}
            >
              수정으로 해결
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>
              취소
            </button>
          </div>
        </section>
      ) : null}
    </article>
  );
}
