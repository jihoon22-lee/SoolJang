import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { authApi } from "@/api/client";
import type { PriceNotice, PriceWatch, PushConfig } from "@/api/priceWatch";
import { priceWatchApi } from "@/api/priceWatch";
import { conditionText, PriceHistoryPanel } from "@/components/PriceHistoryPanel";
import {
  clearBrowserPush,
  currentPushFingerprint,
  enableBrowserPush,
  pushSupported,
} from "@/push/browserPush";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { clearFormDraft, useDraftState } from "@/sync/drafts";

const LABELS: Record<string, string> = {
  unknown: "미조회",
  paused: "일시 중지",
  interest_archived: "관심 대상 보관됨",
  product_unpinned: "외부 상품 고정 필요",
  source_unavailable: "소스 사용 중지",
  history_not_allowed: "가격 이력 보관 미허용",
  connection_unavailable: "연결 사용 불가",
  credential_unavailable: "인증 정보 확인 필요",
  configuration_changed: "설정 변경으로 취소",
  queued: "대기 중",
  running: "조회 중",
  succeeded: "조회 완료",
  skipped: "알림 조건 미충족",
  failed: "실패",
  cancelled: "취소",
  cached: "캐시 사용 · 새 관측 없음",
  unconfirmed: "판본·수집 상태 확인 필요",
  stock_unconfirmed: "재고 확인 필요",
  different_sku: "규격 불일치",
  different_currency: "통화 불일치",
  different_offer: "판매 조건 불일치",
  different_conditions: "판매 조건 불일치",
  stale: "오래된 가격",
  satisfied: "목표가 충족",
  above_target: "목표가 초과",
  notified: "앱 내 알림 생성",
  no_fresh_observation: "새 가격 관측 없음",
  network_error: "네트워크 오류",
  rate_limited: "요청 상한 도달",
  authentication_failed: "인증 오류",
  forbidden: "권한 부족",
  policy_blocked: "출처 정책에 따라 차단",
  sending: "전송 요청 중",
  accepted: "푸시 서비스 접수",
  expired: "구독 만료",
  rejected: "전송 거절",
  retryable: "재시도 대기",
  blocked: "전송 조건 확인 필요",
  queue_full: "전송 대기열 상한 · 앱 내 알림 보존",
  registered: "구독 등록됨",
  vapid_changed: "서버 키 변경 · 구독 갱신 필요",
  interrupted: "중단된 작업",
  empty: "결과 없음",
};
function label(value: string): string {
  return LABELS[value] ?? value;
}
const inflight = (watch: PriceWatch) =>
  watch.latest_run && ["queued", "running"].includes(watch.latest_run.status);

export function PriceWatchPage() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["auth", "me"], queryFn: ({ signal }) => authApi.me(signal) });
  const userId = me.data?.id;
  const watches = useQuery({
    queryKey: ["price-watches", userId],
    queryFn: ({ signal }) => priceWatchApi.list(undefined, signal),
    enabled: Boolean(userId),
    gcTime: 0,
    refetchInterval: (query) => (query.state.data?.some(inflight) ? 2000 : false),
  });
  const notices = useQuery({
    queryKey: ["price-notices", userId],
    queryFn: ({ signal }) => priceWatchApi.notifications(signal),
    enabled: Boolean(userId),
    gcTime: 0,
  });
  const config = useQuery({
    queryKey: ["price-push-config", userId],
    queryFn: ({ signal }) => priceWatchApi.pushConfig(signal),
    enabled: Boolean(userId),
    gcTime: 0,
  });
  useEffect(() => {
    if (!userId || !watches.dataUpdatedAt) return;
    void client.invalidateQueries({ queryKey: ["price-notices", userId] });
    void client.invalidateQueries({ queryKey: ["price-history", userId] });
  }, [client, userId, watches.dataUpdatedAt]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["price-watches", userId] });
    await client.invalidateQueries({ queryKey: ["price-notices", userId] });
    await client.invalidateQueries({ queryKey: ["price-history", userId] });
  };
  return (
    <section className="panel" aria-label="가격 감시와 알림">
      <h2>가격 감시·알림</h2>
      <p className="muted">
        관심 대상의 가격 이력에서 판매 조건을 선택해 목표가를 저장하세요. 정기 조회와 웹 푸시는 각각
        직접 켜야 합니다.
      </p>
      <p className="notice text-sm">
        실제로 새로 관측한 가격의 판본·규격·통화·회원/쿠폰·수령 지역·재고가 모두 맞을 때만 알립니다.
        같은 가격은 반복 알리지 않으며, 목표가 재진입 또는 추가 하락도 설정한 대기 시간을
        적용합니다.
      </p>
      {config.data && !config.data.worker_enabled && (
        <p className="alert" role="alert">
          서버의 가격 감시 작업 실행이 꺼져 있습니다. 저장된 설정은 보존됩니다.
        </p>
      )}
      {config.data?.worker.state === "error" && (
        <p className="alert" role="alert">
          서버 작업 상태를 확인해야 합니다. 대기 작업과 기존 관측을 보존하고 있습니다.
        </p>
      )}
      {watches.isPending && <output>가격 감시를 불러오는 중…</output>}
      {watches.isError && (
        <p className="alert" role="alert">
          {watches.error.message}
        </p>
      )}
      {watches.data?.length === 0 && (
        <p className="notice">
          등록된 가격 감시가 없습니다. 관심 대상에서 실제 가격을 조회한 뒤 목표가를 설정하세요.
        </p>
      )}
      {userId &&
        watches.data?.map((watch) => (
          <WatchCard
            key={`${userId}:${watch.id}`}
            userId={userId}
            watch={watch}
            workerEnabled={config.data?.worker_enabled ?? true}
            onChanged={refresh}
            onHistory={() =>
              setHistoryId(historyId === watch.interest_id ? null : watch.interest_id)
            }
          />
        ))}
      {historyId && <PriceHistoryPanel key={`${userId}:${historyId}`} interestId={historyId} />}
      <h3 className="mt-3">앱 내 알림</h3>
      <p className="muted text-sm">
        푸시를 켜지 않아도 목표가 충족 알림은 여기에 남습니다. 가격은 알림에 표시한 관측 시점의
        값입니다.
      </p>
      {notices.isError && (
        <p className="alert" role="alert">
          {notices.error.message}
        </p>
      )}
      {notices.data?.length === 0 && <p>아직 알림이 없습니다.</p>}
      {notices.data?.map((notice) => (
        <NotificationCard key={notice.id} notice={notice} onChanged={refresh} />
      ))}
      {userId && config.data && <PushSettings key={userId} userId={userId} config={config.data} />}
    </section>
  );
}

function WatchCard({
  userId,
  watch,
  workerEnabled,
  onChanged,
  onHistory,
}: {
  userId: string;
  watch: PriceWatch;
  workerEnabled: boolean;
  onChanged: () => Promise<void>;
  onHistory: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const requestId = useRef<string | null>(null);
  const check = useMutation({
    mutationFn: () => {
      requestId.current ??= crypto.randomUUID();
      return priceWatchApi.check(watch.id, watch.config_revision, requestId.current);
    },
    onSuccess: async () => {
      requestId.current = null;
      await onChanged();
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      priceWatchApi.update(watch.id, {
        expected_revision: watch.config_revision,
        is_active: !watch.is_active,
      }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => priceWatchApi.remove(watch.id, watch.config_revision),
    onSuccess: onChanged,
  });
  return (
    <article className="panel mt-2" aria-label={`${watch.interest_name} 가격 감시`}>
      <h3>{watch.interest_name}</h3>
      <p>
        <strong>
          목표 {watch.criteria.target_amount} {watch.criteria.currency}
        </strong>{" "}
        · {watch.source_name} · {watch.criteria.volume_ml} ml × {watch.criteria.units}
      </p>
      <p className="muted text-sm">{conditionText(watch.criteria.conditions)}</p>
      <dl className="external-info-fields">
        <dt>감시</dt>
        <dd>{watch.is_active ? "사용 중" : "일시 중지"}</dd>
        <dt>정기 조회</dt>
        <dd>
          {watch.schedule_enabled ? `${watch.interval_seconds / 60}분 간격` : "꺼짐 · 수동 조회"}
        </dd>
        <dt>웹 푸시</dt>
        <dd>{watch.push_enabled ? "수신 동의 · 기기 구독 필요" : "꺼짐"}</dd>
      </dl>
      <p>
        최근 결과: {label(watch.last_outcome)}
        {watch.last_checked_at && ` · ${new Date(watch.last_checked_at).toLocaleString("ko-KR")}`}
      </p>
      {watch.blocked_reason && (
        <p className="notice">현재 요청 중지: {label(watch.blocked_reason)}</p>
      )}
      {watch.latest_run && (
        <p className="muted text-sm">
          최근 작업: {label(watch.latest_run.status)} · 시도 {watch.latest_run.attempts}회
          {watch.latest_run.status === "queued" && " · 서버에서 차례대로 실행합니다"}
        </p>
      )}
      {watch.next_due_at && (
        <p className="muted text-sm">
          다음 일정 {new Date(watch.next_due_at).toLocaleString("ko-KR")} · 서버 UTC 간격 기준
        </p>
      )}
      {(check.isError || toggle.isError || remove.isError) && (
        <p className="alert" role="alert">
          {(check.error ?? toggle.error ?? remove.error)?.message}
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          disabled={
            !workerEnabled ||
            Boolean(watch.blocked_reason) ||
            Boolean(inflight(watch)) ||
            check.isPending
          }
          onClick={() => check.mutate()}
        >
          지금 가격 조회
        </button>
        <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {watch.is_active ? "감시 일시 중지" : "감시 다시 사용"}
        </button>
        <button type="button" onClick={() => setEditing(!editing)}>
          {editing ? "설정 닫기" : "감시 설정"}
        </button>
        <button type="button" onClick={onHistory}>
          가격 이력
        </button>
        <button type="button" onClick={() => setRemoving(true)}>
          감시 해제
        </button>
      </div>
      {editing && (
        <WatchEditor
          userId={userId}
          watch={watch}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      )}
      {removing && (
        <div className="alert mt-2" role="alert">
          <p>
            정기 조회와 푸시 대기를 중지합니다. 이미 보낸 요청은 끝날 수 있으며 기존 가격 관측·관심
            대상·알림은 보존합니다.
          </p>
          <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
            감시 해제 확인
          </button>
          <button type="button" onClick={() => setRemoving(false)}>
            취소
          </button>
        </div>
      )}
    </article>
  );
}

function WatchEditor({
  userId,
  watch,
  onSaved,
}: {
  userId: string;
  watch: PriceWatch;
  onSaved: () => Promise<void>;
}) {
  const form = `price-watch-edit:${watch.id}`;
  const initial = {
    revision: watch.config_revision,
    amount: watch.criteria.target_amount,
    maxAgeMinutes: watch.criteria.max_age_seconds / 60,
    schedule: watch.schedule_enabled,
    push: watch.push_enabled,
    intervalMinutes: watch.interval_seconds / 60,
    cooldownMinutes: watch.cooldown_seconds / 60,
  };
  const [draft, setDraft] = useDraftState(form, initial);
  const save = useMutation({
    mutationFn: () =>
      priceWatchApi.update(watch.id, {
        expected_revision: draft.revision,
        target_amount: draft.amount,
        max_age_seconds: draft.maxAgeMinutes * 60,
        schedule_enabled: draft.schedule,
        push_enabled: draft.push,
        interval_seconds: draft.intervalMinutes * 60,
        cooldown_seconds: draft.cooldownMinutes * 60,
      }),
    onSuccess: async () => {
      clearFormDraft(form, userId);
      await onSaved();
    },
  });
  return (
    <form
      className="mt-2"
      aria-label={`${watch.interest_name} 감시 설정`}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DraftRecoveryButton form={form} />
      <p className="notice">
        정기 조회는 외부 요청·요금에 반영될 수 있습니다. 새로 동의한 일정은 조회 간격이 지난 뒤
        시작합니다. 소스의 캐시와 연결별 상한도 적용합니다.
      </p>
      <div className="field">
        <label htmlFor={`target-${watch.id}`}>목표가 ({watch.criteria.currency})</label>
        <input
          id={`target-${watch.id}`}
          type="number"
          min="0"
          step="0.0001"
          required
          value={draft.amount}
          onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`fresh-${watch.id}`}>가격 유효 시간 (분)</label>
        <input
          id={`fresh-${watch.id}`}
          type="number"
          min="1"
          max="1440"
          required
          value={draft.maxAgeMinutes}
          onChange={(event) => setDraft({ ...draft, maxAgeMinutes: Number(event.target.value) })}
        />
      </div>
      <label>
        <input
          type="checkbox"
          checked={draft.schedule}
          onChange={(event) => setDraft({ ...draft, schedule: event.target.checked })}
        />{" "}
        정기 가격 조회에 동의
      </label>
      {draft.schedule && (
        <div className="field">
          <label htmlFor={`interval-${watch.id}`}>조회 간격 (분)</label>
          <input
            id={`interval-${watch.id}`}
            type="number"
            min="15"
            max="10080"
            required
            value={draft.intervalMinutes}
            onChange={(event) =>
              setDraft({ ...draft, intervalMinutes: Number(event.target.value) })
            }
          />
        </div>
      )}
      <div className="field">
        <label htmlFor={`cooldown-${watch.id}`}>다시 알리기 최소 간격 (분)</label>
        <input
          id={`cooldown-${watch.id}`}
          type="number"
          min="15"
          max="10080"
          required
          value={draft.cooldownMinutes}
          onChange={(event) => setDraft({ ...draft, cooldownMinutes: Number(event.target.value) })}
        />
      </div>
      <label>
        <input
          type="checkbox"
          checked={draft.push}
          onChange={(event) => setDraft({ ...draft, push: event.target.checked })}
        />{" "}
        이 대상의 웹 푸시 수신에 동의
      </label>
      <p className="muted text-sm">
        기기별 브라우저 수신도 아래에서 별도로 켜세요. 푸시에는 제품명·가격·구매 기록을 넣지
        않습니다.
      </p>
      {save.isError && (
        <p className="alert" role="alert">
          {save.error.message}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="primary" disabled={save.isPending}>
          감시 설정 저장
        </button>
        <button
          type="button"
          onClick={() => {
            clearFormDraft(form, userId);
            setDraft(initial);
          }}
        >
          서버 값 다시 불러오기
        </button>
      </div>
    </form>
  );
}

function NotificationCard({
  notice,
  onChanged,
}: {
  notice: PriceNotice;
  onChanged: () => Promise<void>;
}) {
  const read = useMutation({
    mutationFn: () => priceWatchApi.read(notice.id),
    onSuccess: onChanged,
  });
  return (
    <article className="panel mt-1" aria-label="목표가 충족 알림">
      <strong>목표가 조건 확인</strong>
      <p>
        {notice.amount !== null
          ? `${notice.amount} ${notice.currency}`
          : "원관측 보관 기간이 지났습니다"}
        {notice.observed_at && ` · 관측 ${new Date(notice.observed_at).toLocaleString("ko-KR")}`}
      </p>
      <p className="muted text-sm">
        {notice.delivery_states.length
          ? notice.delivery_states
              .map((state) =>
                state === "unknown" ? "전달 여부 미확인 · 자동 재전송 안 함" : label(state),
              )
              .join(" · ")
          : "앱 내 알림"}
      </p>
      {notice.source_url && /^(https?:)\/\//.test(notice.source_url) && (
        <a
          className="source-link"
          href={notice.source_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          판매 조건 원문 열기
        </a>
      )}
      {notice.read_at ? (
        <span className="muted ml-1">읽음</span>
      ) : (
        <button
          type="button"
          className="ml-1"
          disabled={read.isPending}
          onClick={() => read.mutate()}
        >
          읽음으로 표시
        </button>
      )}
      {read.isError && (
        <p className="alert" role="alert">
          {read.error.message}
        </p>
      )}
    </article>
  );
}

function PushSettings({ userId, config }: { userId: string; config: PushConfig }) {
  const client = useQueryClient();
  const subscriptions = useQuery({
    queryKey: ["price-push-subscriptions", userId],
    queryFn: ({ signal }) => priceWatchApi.subscriptions(signal),
    gcTime: 0,
  });
  const current = useQuery({
    queryKey: ["price-push-browser", userId],
    queryFn: currentPushFingerprint,
    gcTime: 0,
  });
  const enable = useMutation({
    mutationFn: () => {
      if (!config.public_key) throw new Error("서버의 웹 푸시 설정이 필요합니다.");
      return enableBrowserPush(config.public_key);
    },
    gcTime: 0,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["price-push-subscriptions", userId] });
      await client.invalidateQueries({ queryKey: ["price-push-browser", userId] });
    },
  });
  const disable = useMutation({
    mutationFn: async (id: string) => {
      const row = subscriptions.data?.find((item) => item.id === id);
      await priceWatchApi.unsubscribe(id);
      if (row?.endpoint_hash === current.data) await clearBrowserPush();
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["price-push-subscriptions", userId] });
      await client.invalidateQueries({ queryKey: ["price-push-browser", userId] });
    },
  });
  return (
    <section className="panel mt-3" aria-label="브라우저 푸시 수신">
      <h3>브라우저 푸시 수신</h3>
      <p className="muted">
        수신할 대상의 푸시 동의와 이 기기의 브라우저 권한이 모두 필요합니다. 푸시 서비스 접수는 화면
        표시 성공과 다릅니다. 전송 응답이 유실되면 중복을 줄이기 위해 자동 재전송하지 않습니다.
      </p>
      {!config.configured && (
        <p className="notice">
          서버의 웹 푸시 설정이 준비되지 않았습니다. 앱 내 알림은 사용할 수 있습니다.
        </p>
      )}
      {!pushSupported() && <p className="notice">이 브라우저에서는 웹 푸시를 지원하지 않습니다.</p>}
      <button
        type="button"
        disabled={!config.configured || !pushSupported() || enable.isPending}
        onClick={() => enable.mutate()}
      >
        이 브라우저에서 수신 허용
      </button>
      {(enable.isError || disable.isError || subscriptions.isError) && (
        <p className="alert" role="alert">
          {(enable.error ?? disable.error ?? subscriptions.error)?.message}
        </p>
      )}
      {subscriptions.data?.map((row) => (
        <div key={row.id} className="mt-2">
          <span>
            {row.endpoint_hash === current.data ? "현재 브라우저" : "등록한 다른 기기"} ·{" "}
            {label(row.last_outcome)}
            {!row.is_active && " · 수신 중지"}
          </span>
          <button
            className="ml-1"
            type="button"
            disabled={disable.isPending}
            onClick={() => disable.mutate(row.id)}
          >
            이 기기 구독 해제
          </button>
        </div>
      ))}
    </section>
  );
}
