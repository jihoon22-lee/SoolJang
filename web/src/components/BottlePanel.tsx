/**
 * 병 상태 전이와 시음 기록.
 *
 * 상태 전이를 버튼으로 노출한다. 증여·판매는 날짜·메모를 받는 시트로 한 번 더 확인한다.
 * 잔량은 `null` 이 "미개봉(전량)" 이라는 뜻이다. 0ml 이 아니므로 그대로 표시하면 안 된다.
 */

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { bottlesApi, tastingsApi } from "@/api/client";
import type { Bottle, BottleStatus } from "@/api/types";
import { type HandOverAction, HandOverSheet } from "@/components/HandOverSheet";
import { HistoryDetails } from "@/components/HistoryList";
import { RemainingEditor } from "@/components/RemainingEditor";
import { TastingFields, type TastingFieldValues } from "@/components/TastingFields";
import { todayLocal } from "@/format";
import {
  applyBottleTransition,
  type TransitionAction,
  type TransitionOptions,
} from "@/sync/bottleActions";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { db } from "@/sync/db";
import { captureFormDraft, clearSubmittedDraft, useDraftState } from "@/sync/drafts";
import { lastTastingContext, recordTasting, rememberTastingContext } from "@/sync/tastingActions";
import { useSessionMutation } from "@/sync/useSessionMutation";
import { captureWriteSession } from "@/sync/writeSession";

export const STATUS_LABELS: Record<BottleStatus, string> = {
  unopened: "미개봉",
  open: "개봉",
  finished: "소진",
  gifted: "증여",
  sold: "판매",
};

export function formatRemaining(bottle: Bottle): string {
  if (bottle.status === "unopened") return "미개봉 (전량)";
  if (bottle.remaining_ml === null) return "잔량 미기록";
  return `${bottle.remaining_ml.toLocaleString("ko-KR")}ml`;
}

interface BottlePanelProps {
  bottle: Bottle;
  /** 시음 기록 삭제는 서버 상태만 갖고 있어 온라인에서만 할 수 있다. */
  offline?: boolean;
  onSavingChange?: (saving: boolean) => void;
  contextLabel?: string | undefined;
  selectedTastingId?: string | undefined;
}

export function BottlePanel({
  bottle,
  offline = false,
  onSavingChange,
  contextLabel,
  selectedTastingId,
}: BottlePanelProps): React.JSX.Element {
  const [savingTarget, setSavingTarget] = useState<string | null>(null);
  const savingTasting = savingTarget === bottle.id;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [session] = useState(captureWriteSession);

  const timeline = useInfiniteQuery({
    queryKey: ["bottles", bottle.id, "tastings", "pages"],
    queryFn: ({ pageParam, signal }) =>
      bottlesApi.tastingsPage(bottle.id, { limit: 50, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !offline,
  });
  const tastingItems = [
    ...new Map(
      (timeline.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
    ).values(),
  ];

  const selectedTastingLoaded = tastingItems.some((item) => item.id === selectedTastingId);
  const selectedTastingRef = useRef<HTMLLIElement>(null);
  const focusedTasting = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedTastingId) {
      focusedTasting.current = undefined;
      return;
    }
    if (
      !selectedTastingLoaded ||
      !selectedTastingRef.current ||
      focusedTasting.current === selectedTastingId
    )
      return;
    focusedTasting.current = selectedTastingId;
    selectedTastingRef.current.scrollIntoView?.({ block: "nearest" });
    selectedTastingRef.current.focus({ preventScroll: true });
  }, [selectedTastingId, selectedTastingLoaded]);

  const summary = useQuery({
    queryKey: ["tastings", "summary", bottle.id],
    queryFn: ({ signal }) => tastingsApi.summary({ bottle_id: bottle.id }, signal),
    enabled: !offline,
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!session.isCurrent()) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bottles", bottle.id] }),
      queryClient.invalidateQueries({ queryKey: ["tastings", "summary", bottle.id] }),
    ]);
  }, [queryClient, bottle.id, session]);
  const queuedTastings = useLiveQuery(
    async () => ({
      bottleId: bottle.id,
      keys: await db.outbox
        .filter(
          (entry) => entry.entity === "tasting_session" && entry.fields.bottle_id === bottle.id,
        )
        .primaryKeys(),
    }),
    [bottle.id, session.userId],
  );
  const previousQueued = useRef<typeof queuedTastings>(undefined);
  useEffect(() => {
    if (!queuedTastings) return;
    const previous = previousQueued.current;
    previousQueued.current = queuedTastings;
    // 로컬 저장 직후에는 서버에 없을 수 있다. outbox에서 빠진 뒤 전체 페이지와 요약을
    // 다시 받는다. 실패해 대기 중인 명령을 서버에 반영된 기록처럼 표시하지 않는다.
    if (
      previous?.bottleId === queuedTastings.bottleId &&
      previous.keys.some((key) => !queuedTastings.keys.includes(key))
    )
      void refresh();
  }, [queuedTastings, refresh]);

  const [handOver, setHandOver] = useState<HandOverAction | null>(null);
  const transition = useSessionMutation({
    mutationFn: async (
      input: TransitionAction | { action: TransitionAction; options: TransitionOptions },
    ) => {
      const { action, options } =
        typeof input === "string" ? { action: input, options: {} } : input;
      await applyBottleTransition(bottle.id, action, options);
    },
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "상태를 바꿀 수 없습니다");
    },
  });

  const deleteTasting = useSessionMutation({
    networkMode: "online",
    mutationFn: (tastingId: string) => tastingsApi.remove(tastingId),
    onSuccess: refresh,
  });
  const deletingTastingId = deleteTasting.isPending ? (deleteTasting.variables ?? null) : null;

  function handleDeleteTasting(tastingId: string): void {
    // 잔량은 되돌리지 않는다(백엔드 정책) — 지우기 전에 그 사실을 알려준다.
    if (!window.confirm("이 시음 기록을 삭제할까요? 병의 잔량은 되돌리지 않습니다.")) return;
    deleteTasting.mutate(tastingId);
  }

  return (
    <section className="bottle-panel">
      <header className="bottle-panel-header">
        <h3>
          {bottle.label_no}번 병
          <span className={`bottle-badge bottle-badge-${bottle.status}`}>
            {STATUS_LABELS[bottle.status]}
          </span>
        </h3>
        <p className="bottle-remaining">{formatRemaining(bottle)}</p>
        {contextLabel ? <p className="muted bottle-context">{contextLabel}</p> : null}
      </header>

      <dl className="bottle-dates">
        <dt>개봉일</dt>
        <dd>{bottle.opened_on ?? "—"}</dd>
        <dt>소진일</dt>
        <dd>{bottle.finished_on ?? "—"}</dd>
      </dl>

      <fieldset className="bottle-actions" disabled={savingTasting}>
        <legend>상태 바꾸기</legend>
        {bottle.status === "unopened" ? (
          <button
            type="button"
            onClick={() => transition.mutate("open")}
            disabled={transition.isPending}
          >
            개봉
          </button>
        ) : null}
        {bottle.status === "open" ? (
          <button
            type="button"
            onClick={() => transition.mutate("finish")}
            disabled={transition.isPending}
          >
            소진
          </button>
        ) : null}
        {bottle.status === "open" ? (
          <button
            type="button"
            onClick={() => transition.mutate("unopen")}
            disabled={transition.isPending}
          >
            개봉 취소
          </button>
        ) : null}
        {bottle.status === "unopened" || bottle.status === "open" ? (
          <>
            <button
              type="button"
              onClick={() => setHandOver("gift")}
              disabled={transition.isPending}
              aria-expanded={handOver === "gift"}
            >
              증여
            </button>
            <button
              type="button"
              onClick={() => setHandOver("sell")}
              disabled={transition.isPending}
              aria-expanded={handOver === "sell"}
            >
              판매
            </button>
          </>
        ) : null}
        {bottle.status !== "unopened" && bottle.status !== "open" ? (
          <button
            type="button"
            onClick={() => transition.mutate("reopen")}
            disabled={transition.isPending}
          >
            되돌리기
          </button>
        ) : null}
      </fieldset>

      {handOver ? (
        <HandOverSheet
          action={handOver}
          count={1}
          pending={transition.isPending || savingTasting}
          onCancel={() => setHandOver(null)}
          onConfirm={({ on, note }) =>
            transition.mutate(
              { action: handOver, options: { on, note: note || undefined } },
              { onSuccess: () => setHandOver(null) },
            )
          }
        />
      ) : null}

      {bottle.status === "open" ? (
        <RemainingEditor
          bottle={bottle}
          pending={transition.isPending || savingTasting}
          onSet={(remainingMl) =>
            transition.mutate({ action: "set_remaining", options: { remainingMl } })
          }
        />
      ) : null}

      {error ? (
        <p className="bottle-error" role="alert">
          {error}
        </p>
      ) : null}

      {summary.data && summary.data.session_count > 0 ? (
        <dl className="tasting-summary">
          <dt>시음 횟수</dt>
          <dd>{summary.data.session_count}회</dd>
          <dt>평균 평점</dt>
          <dd>{summary.data.average_rating ?? "기록 없음"}</dd>
          <dt>평점 변화</dt>
          <dd>{formatRatingChange(summary.data.rating_change)}</dd>
          <dt>총 따른 양</dt>
          <dd>{summary.data.total_poured_ml.toLocaleString("ko-KR")}ml</dd>
        </dl>
      ) : null}

      <HistoryDetails
        queryKey={["bottles", bottle.id, "history"]}
        load={(signal) => bottlesApi.history(bottle.id, signal)}
        online={!offline}
      />

      <TastingForm
        key={bottle.id}
        onSavingChange={(saving) => {
          setSavingTarget(saving ? bottle.id : null);
          onSavingChange?.(saving);
        }}
        bottleId={bottle.id}
        remainingMl={bottle.status === "open" ? bottle.remaining_ml : null}
        onSaved={refresh}
      />

      <div className="tasting-timeline">
        <h4>시음 기록</h4>
        {timeline.isPending && !offline ? <output>불러오는 중…</output> : null}
        {offline && !timeline.data ? (
          <p className="muted">온라인으로 연결하면 시음 기록을 불러올 수 있습니다.</p>
        ) : null}
        {timeline.isError && !timeline.data ? (
          <>
            <p role="alert">시음 기록을 불러오지 못했습니다. 다시 시도하세요.</p>
            <button
              type="button"
              disabled={offline || timeline.isFetching}
              onClick={() => void timeline.refetch()}
            >
              시음 기록 다시 불러오기
            </button>
          </>
        ) : null}
        {timeline.data && tastingItems.length === 0 ? (
          <p className="muted">아직 기록이 없습니다.</p>
        ) : null}
        {timeline.isRefetchError ? (
          <>
            <p role="alert">최신 시음 기록을 확인하지 못했습니다. 기존 내역을 표시합니다.</p>
            <button
              type="button"
              disabled={offline || timeline.isFetching}
              onClick={() => void timeline.refetch()}
            >
              목록 새로고침
            </button>
          </>
        ) : null}
        <ul>
          {tastingItems.map((item) => (
            <li
              key={item.id}
              id={`tasting-${item.id}`}
              className={item.id === selectedTastingId ? "tasting-selected" : undefined}
              ref={item.id === selectedTastingId ? selectedTastingRef : undefined}
              tabIndex={item.id === selectedTastingId ? -1 : undefined}
              aria-current={item.id === selectedTastingId ? "true" : undefined}
            >
              <span className="tasting-date">{item.tasted_on}</span>
              <span className="tasting-rating">
                {item.rating ? `${item.rating}점` : "평점 없음"}
              </span>
              {item.poured_ml ? <span className="tasting-poured">{item.poured_ml}ml</span> : null}
              {item.nose ? <p className="tasting-note">향: {item.nose}</p> : null}
              {item.palate ? <p className="tasting-note">맛: {item.palate}</p> : null}
              {item.finish ? <p className="tasting-note">피니시: {item.finish}</p> : null}
              {item.place || item.companions ? (
                <p className="tasting-meta">
                  {[item.place, item.companions].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {!offline && (
                <button
                  type="button"
                  className="sort-button tasting-delete"
                  onClick={() => handleDeleteTasting(item.id)}
                  disabled={savingTasting || deletingTastingId === item.id}
                >
                  {deletingTastingId === item.id ? "삭제 중…" : "삭제"}
                </button>
              )}
            </li>
          ))}
        </ul>
        {selectedTastingId &&
        timeline.data &&
        !tastingItems.some((item) => item.id === selectedTastingId) ? (
          <output className="muted">
            {timeline.hasNextPage
              ? "선택한 시음은 아직 이 목록에 없습니다. 이전 기록 더 보기로 확인하세요."
              : "선택한 시음을 현재 목록에서 확인할 수 없습니다."}
          </output>
        ) : null}
        {timeline.isFetchNextPageError ? (
          <p role="alert">이전 기록을 더 불러오지 못했습니다. 이미 불러온 내역은 유지됩니다.</p>
        ) : null}
        {timeline.hasNextPage ? (
          <button
            type="button"
            disabled={offline || timeline.isFetching}
            onClick={() => void timeline.fetchNextPage({ cancelRefetch: false })}
          >
            {timeline.isFetchingNextPage
              ? "이전 기록 불러오는 중…"
              : timeline.isFetchNextPageError
                ? "이전 기록 다시 불러오기"
                : "이전 기록 더 보기"}
          </button>
        ) : null}
        {deleteTasting.error ? (
          <p role="alert">시음 기록을 삭제하지 못했습니다. 다시 시도하세요.</p>
        ) : null}
        {offline ? <p className="muted">시음 기록 삭제는 온라인일 때만 할 수 있습니다.</p> : null}
      </div>
    </section>
  );
}

/** 평점 변화를 부호와 함께 보여준다. 처음보다 좋아졌는지가 핵심 정보다. */
export function formatRatingChange(change: string | null): string {
  if (change === null) return "비교할 기록 없음";
  const value = Number(change);
  if (Number.isNaN(value)) return "비교할 기록 없음";
  if (value === 0) return "변화 없음";
  return value > 0 ? `+${change} (좋아짐)` : `${change} (낮아짐)`;
}

interface TastingFormProps {
  bottleId: string;
  remainingMl?: number | null | undefined;
  onSaved: () => Promise<void>;
  onSavingChange: (saving: boolean) => void;
}

function TastingForm({
  bottleId,
  remainingMl,
  onSaved,
  onSavingChange,
}: TastingFormProps): React.JSX.Element {
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const context = lastTastingContext();
  const [tastedOn, setTastedOn] = useDraftState(`tasting:${bottleId}:tastedOn`, () => todayLocal());
  const [pouredMl, setPouredMl] = useDraftState(`tasting:${bottleId}:pouredMl`, "");
  const [rating, setRating] = useDraftState(`tasting:${bottleId}:rating`, "");
  const [nose, setNose] = useDraftState(`tasting:${bottleId}:nose`, "");
  const [palate, setPalate] = useDraftState(`tasting:${bottleId}:palate`, "");
  const [finish, setFinish] = useDraftState(`tasting:${bottleId}:finish`, "");
  const [place, setPlace] = useDraftState(`tasting:${bottleId}:place`, context.place);
  const [companions, setCompanions] = useDraftState(
    `tasting:${bottleId}:companions`,
    context.companions,
  );
  const [error, setError] = useState<string | null>(null);

  const values: TastingFieldValues = {
    tastedOn,
    pouredMl,
    rating,
    nose,
    palate,
    finish,
    place,
    companions,
  };
  const setters: Record<keyof TastingFieldValues, (value: string) => void> = {
    tastedOn: setTastedOn,
    pouredMl: setPouredMl,
    rating: setRating,
    nose: setNose,
    palate: setPalate,
    finish: setFinish,
    place: setPlace,
    companions: setCompanions,
  };

  const mutation = useSessionMutation<string, { bottleId: string; values: TastingFieldValues }>({
    mutationFn: ({ bottleId: targetId, values: submitted }, session) =>
      recordTasting({
        bottleId: targetId,
        ...submitted,
        pouredMl: submitted.pouredMl ? Number(submitted.pouredMl) : null,
        rating: submitted.rating || null,
        userId: session.userId,
      }),
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    onSavingChange(true);
    const session = captureWriteSession();
    const submitted = { ...values };
    const draft = captureFormDraft(`tasting:${bottleId}`);
    try {
      await mutation.mutateAsync({ bottleId, values: submitted });
      if (!session.isCurrent()) return;
      rememberTastingContext({
        place: submitted.place.trim(),
        companions: submitted.companions.trim(),
      });
      const cleared = clearSubmittedDraft(draft);
      if (!mounted.current) return;
      setError(null);
      if (cleared) {
        setPouredMl("");
        setRating("");
        setNose("");
        setPalate("");
        setFinish("");
      }
      await onSaved();
    } catch (cause) {
      if (mounted.current && session.isCurrent())
        setError(cause instanceof Error ? cause.message : "기록에 실패했습니다");
    } finally {
      saving.current = false;
      if (mounted.current && session.isCurrent()) {
        setPending(false);
        onSavingChange(false);
      }
    }
  }

  return (
    <form className="tasting-form" onSubmit={handleSubmit}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0 }}>
        <DraftRecoveryButton form={`tasting:${bottleId}`} />
        <h4>시음 기록하기</h4>

        <TastingFields
          values={values}
          remainingMl={remainingMl}
          onChange={(patch) => {
            if (saving.current) return;
            for (const [key, value] of Object.entries(patch)) {
              setters[key as keyof TastingFieldValues](value as string);
            }
          }}
        />

        {error ? (
          <p className="bottle-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={pending}>
          {pending ? "저장 중…" : "기록 저장"}
        </button>
      </fieldset>
    </form>
  );
}
