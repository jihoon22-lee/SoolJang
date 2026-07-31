/**
 * 병 상태 전이와 시음 기록.
 *
 * 상태 전이를 버튼으로 노출한다. 증여·판매는 되돌리기가 번거로우므로 확인을 받는다.
 * 잔량은 `null` 이 "미개봉(전량)" 이라는 뜻이다. 0ml 이 아니므로 그대로 표시하면 안 된다.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { ApiError, bottlesApi, tastingsApi } from "@/api/client";
import type { Bottle, BottleStatus } from "@/api/types";

const STATUS_LABELS: Record<BottleStatus, string> = {
  unopened: "미개봉",
  open: "개봉",
  finished: "소진",
  gifted: "증여",
  sold: "판매",
};

/** 평점 선택지. 6점 만점 0.5 단위 — 레거시 시트와 같은 척도다. */
const RATING_OPTIONS = Array.from({ length: 13 }, (_, index) => (index * 0.5).toFixed(1));

export function formatRemaining(bottle: Bottle): string {
  if (bottle.status === "unopened") return "미개봉 (전량)";
  if (bottle.remaining_ml === null) return "잔량 미기록";
  return `${bottle.remaining_ml.toLocaleString("ko-KR")}ml`;
}

interface BottlePanelProps {
  bottle: Bottle;
}

export function BottlePanel({ bottle }: BottlePanelProps): React.JSX.Element {
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

  const transition = useMutation({
    mutationFn: (action: "open" | "finish" | "gift" | "sell" | "reopen") => {
      if (action === "open") return bottlesApi.open(bottle.id);
      if (action === "finish") return bottlesApi.finish(bottle.id);
      if (action === "gift") return bottlesApi.gift(bottle.id);
      if (action === "sell") return bottlesApi.sell(bottle.id);
      return bottlesApi.reopen(bottle.id);
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "상태를 바꿀 수 없습니다");
    },
  });

  function handOver(action: "gift" | "sell"): void {
    const label = action === "gift" ? "증여" : "판매";
    // 되돌리기가 번거로운 동작이므로 확인을 받는다.
    if (!window.confirm(`이 병을 ${label} 처리할까요? 재고에서 빠집니다.`)) return;
    transition.mutate(action);
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
        {bottle.status === "unopened" || bottle.status === "open" ? (
          <>
            <button type="button" onClick={() => handOver("gift")} disabled={transition.isPending}>
              증여
            </button>
            <button type="button" onClick={() => handOver("sell")} disabled={transition.isPending}>
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

      <TastingForm bottleId={bottle.id} onSaved={refresh} />

      <div className="tasting-timeline">
        <h4>시음 기록</h4>
        {timeline.isPending ? <output>불러오는 중…</output> : null}
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
            </li>
          ))}
        </ul>
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
  onSaved: () => void;
}

function TastingForm({ bottleId, onSaved }: TastingFormProps): React.JSX.Element {
  const [tastedOn, setTastedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [pouredMl, setPouredMl] = useState("");
  const [rating, setRating] = useState("");
  const [nose, setNose] = useState("");
  const [palate, setPalate] = useState("");
  const [finish, setFinish] = useState("");
  const [place, setPlace] = useState("");
  const [companions, setCompanions] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      tastingsApi.create({
        tasted_on: tastedOn,
        bottle_id: bottleId,
        ...(pouredMl ? { poured_ml: Number(pouredMl) } : {}),
        ...(rating ? { rating } : {}),
        ...(nose.trim() ? { nose: nose.trim() } : {}),
        ...(palate.trim() ? { palate: palate.trim() } : {}),
        ...(finish.trim() ? { finish: finish.trim() } : {}),
        ...(place.trim() ? { place: place.trim() } : {}),
        ...(companions.trim() ? { companions: companions.trim() } : {}),
      }),
    onSuccess: () => {
      setError(null);
      setPouredMl("");
      setRating("");
      setNose("");
      setPalate("");
      setFinish("");
      onSaved();
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "기록에 실패했습니다");
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form className="tasting-form" onSubmit={handleSubmit}>
      <h4>시음 기록하기</h4>

      <label htmlFor={`tasted-on-${bottleId}`}>
        마신 날
        <input
          id={`tasted-on-${bottleId}`}
          type="date"
          required
          value={tastedOn}
          onChange={(event) => setTastedOn(event.target.value)}
        />
      </label>

      <label htmlFor={`poured-${bottleId}`}>
        따른 양 (ml)
        <input
          id={`poured-${bottleId}`}
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="기억나지 않으면 비워 두세요"
          value={pouredMl}
          onChange={(event) => setPouredMl(event.target.value)}
        />
      </label>

      <label htmlFor={`rating-${bottleId}`}>
        평점 (6점 만점)
        <select
          id={`rating-${bottleId}`}
          value={rating}
          onChange={(event) => setRating(event.target.value)}
        >
          <option value="">평점 없음</option>
          {RATING_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor={`nose-${bottleId}`}>
        향
        <input
          id={`nose-${bottleId}`}
          value={nose}
          onChange={(event) => setNose(event.target.value)}
        />
      </label>

      <label htmlFor={`palate-${bottleId}`}>
        맛
        <input
          id={`palate-${bottleId}`}
          value={palate}
          onChange={(event) => setPalate(event.target.value)}
        />
      </label>

      <label htmlFor={`finish-${bottleId}`}>
        피니시
        <input
          id={`finish-${bottleId}`}
          value={finish}
          onChange={(event) => setFinish(event.target.value)}
        />
      </label>

      <label htmlFor={`place-${bottleId}`}>
        장소
        <input
          id={`place-${bottleId}`}
          value={place}
          onChange={(event) => setPlace(event.target.value)}
        />
      </label>

      <label htmlFor={`companions-${bottleId}`}>
        동석자
        <input
          id={`companions-${bottleId}`}
          value={companions}
          onChange={(event) => setCompanions(event.target.value)}
        />
      </label>

      {error ? (
        <p className="bottle-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "저장 중…" : "기록 저장"}
      </button>
    </form>
  );
}
