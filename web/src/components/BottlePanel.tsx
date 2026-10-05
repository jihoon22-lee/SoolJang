/**
 * 병 상태 전이와 시음 기록.
 *
 * 상태 전이를 버튼으로 노출한다. 증여·판매는 날짜·메모를 받는 시트로 한 번 더 확인한다.
 * 잔량은 `null` 이 "미개봉(전량)" 이라는 뜻이다. 0ml 이 아니므로 그대로 표시하면 안 된다.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { bottlesApi, tastingsApi } from "@/api/client";
import type { Bottle, BottleStatus, User } from "@/api/types";
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
import { clearFormDraft, useDraftState } from "@/sync/drafts";
import { lastTastingContext, recordTasting, rememberTastingContext } from "@/sync/tastingActions";

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
}

export function BottlePanel({ bottle, offline = false }: BottlePanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const timeline = useQuery({
    queryKey: ["bottles", bottle.id, "tastings"],
    queryFn: ({ signal }) => bottlesApi.tastings(bottle.id, signal),
  });

  const summary = useQuery({
    queryKey: ["tastings", "summary", bottle.id],
    queryFn: ({ signal }) => tastingsApi.summary({ bottle_id: bottle.id }, signal),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["bottles"] });
    void queryClient.invalidateQueries({ queryKey: ["tastings"] });
  }

  const [handOver, setHandOver] = useState<HandOverAction | null>(null);
  const transition = useMutation({
    mutationFn: async (
      input: TransitionAction | { action: TransitionAction; options: TransitionOptions },
    ) => {
      const { action, options } =
        typeof input === "string" ? { action: input, options: {} } : input;
      await applyBottleTransition(bottle.id, action, options);
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "상태를 바꿀 수 없습니다");
    },
  });

  const deleteTasting = useMutation({
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
      </header>

      <dl className="bottle-dates">
        <dt>개봉일</dt>
        <dd>{bottle.opened_on ?? "—"}</dd>
        <dt>소진일</dt>
        <dd>{bottle.finished_on ?? "—"}</dd>
      </dl>

      <fieldset className="bottle-actions">
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
          pending={transition.isPending}
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
          pending={transition.isPending}
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
        bottleId={bottle.id}
        remainingMl={bottle.status === "open" ? bottle.remaining_ml : null}
        onSaved={refresh}
      />

      <div className="tasting-timeline">
        <h4>시음 기록</h4>
        {timeline.isPending ? <output>불러오는 중…</output> : null}
        {timeline.isError ? (
          <p className="muted">오프라인에서는 시음 기록을 불러올 수 없습니다.</p>
        ) : null}
        {timeline.data?.length === 0 ? <p className="muted">아직 기록이 없습니다.</p> : null}
        <ul>
          {timeline.data?.map((item) => (
            <li key={item.id}>
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
                  disabled={deletingTastingId === item.id}
                >
                  {deletingTastingId === item.id ? "삭제 중…" : "삭제"}
                </button>
              )}
            </li>
          ))}
        </ul>
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
  onSaved: () => void;
}

function TastingForm({ bottleId, remainingMl, onSaved }: TastingFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
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

  const mutation = useMutation({
    mutationFn: () =>
      recordTasting({
        bottleId,
        tastedOn,
        pouredMl: pouredMl ? Number(pouredMl) : null,
        rating: rating || null,
        nose,
        palate,
        finish,
        place,
        companions,
        userId: queryClient.getQueryData<User>(["auth", "me"])?.id ?? "",
      }),
    onSuccess: () => {
      rememberTastingContext({ place: place.trim(), companions: companions.trim() });
      clearFormDraft(`tasting:${bottleId}`);
      setError(null);
      setPouredMl("");
      setRating("");
      setNose("");
      setPalate("");
      setFinish("");
      onSaved();
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "기록에 실패했습니다");
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form className="tasting-form" onSubmit={handleSubmit}>
      <DraftRecoveryButton form={`tasting:${bottleId}`} />
      <h4>시음 기록하기</h4>

      <TastingFields
        values={values}
        remainingMl={remainingMl}
        onChange={(patch) => {
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

      <button type="submit" className="primary" disabled={mutation.isPending}>
        {mutation.isPending ? "저장 중…" : "기록 저장"}
      </button>
    </form>
  );
}
