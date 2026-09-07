import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { authApi } from "@/api/client";
import type { PriceHistoryRow } from "@/api/priceWatch";
import { priceWatchApi } from "@/api/priceWatch";
import { DraftRecoveryButton } from "@/sync/DraftRecoveryButton";
import { clearFormDraft, useDraftState } from "@/sync/drafts";

const CONDITION_LABELS: Record<string, string> = {
  price_kind: "가격 종류",
  membership: "회원",
  coupon: "쿠폰",
  fulfillment: "수령",
  region: "지역",
  shipping: "배송",
  tax: "세금",
};
export function conditionText(values: Record<string, unknown>): string {
  return Object.entries(CONDITION_LABELS)
    .map(
      ([key, label]) =>
        `${label}: ${values[key] === null || values[key] === undefined ? "미확인" : String(values[key])}`,
    )
    .join(" · ");
}

export function PriceHistoryPanel({
  interestId,
  productId,
  onSaveInterest,
}: {
  interestId?: string;
  productId?: string;
  onSaveInterest?: () => void;
}) {
  const [selected, setSelected] = useState<PriceHistoryRow | null>(null);
  const me = useQuery({ queryKey: ["auth", "me"], queryFn: ({ signal }) => authApi.me(signal) });
  const userId = me.data?.id;
  const history = useQuery({
    queryKey: ["price-history", userId, interestId ?? productId],
    queryFn: ({ signal }) =>
      interestId
        ? priceWatchApi.history(interestId, signal)
        : priceWatchApi.productHistory(productId ?? "", signal),
    enabled: Boolean(userId && (interestId || productId)),
    gcTime: 0,
  });
  const latest = new Set<string>();
  return (
    <section className="panel mt-2" aria-label="가격 관측 이력">
      <h3>가격 관측 이력</h3>
      <p className="muted">
        실제로 조회해 저장한 최근 100개 관측입니다. 같은 판매 조건끼리 확인하세요. 최초 관측 전
        가격은 추정하지 않습니다.
      </p>
      {history.isPending && <output>가격 이력을 불러오는 중…</output>}
      {history.isError && (
        <p className="alert" role="alert">
          {history.error.message}
        </p>
      )}
      {history.data?.length === 0 && (
        <p className="notice">
          아직 저장된 가격 관측이 없습니다. 허용된 소스에서 가격과 판매 조건을 먼저 조회하세요.
        </p>
      )}
      {history.data?.map((row) => {
        const isLatest = !latest.has(row.offer_id);
        latest.add(row.offer_id);
        return (
          <article key={row.id} className="panel mt-1">
            <strong>
              {row.amount} {row.currency}
            </strong>{" "}
            · {row.source_name}
            <p>
              {String(row.facts.volume_ml ?? "미확인")} ml · {String(row.facts.units ?? "미확인")}개
              ·{" "}
              {row.facts.in_stock === true
                ? "재고 확인"
                : row.facts.in_stock === false
                  ? "품절"
                  : "재고 미확인"}
            </p>
            <p className="muted text-sm">{conditionText(row.facts)}</p>
            <p className="muted text-sm">관측 {new Date(row.fetched_at).toLocaleString("ko-KR")}</p>
            {/^(https?:)\/\//.test(row.source_url) && (
              <a href={row.source_url} target="_blank" rel="noopener noreferrer">
                가격 출처 열기
              </a>
            )}
            {isLatest && interestId && (
              <button type="button" className="ml-1" onClick={() => setSelected(row)}>
                이 판매 조건의 목표가 설정
              </button>
            )}
          </article>
        );
      })}
      {productId &&
        (onSaveInterest ? (
          <button type="button" onClick={onSaveInterest}>
            관심 저장 후 목표가 설정
          </button>
        ) : (
          <a href="#interests">관심 저장 후 목표가 설정</a>
        ))}
      {selected && userId && interestId && (
        <NewWatch
          key={`${userId}:${selected.offer_id}`}
          userId={userId}
          interestId={interestId}
          offer={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function NewWatch({
  userId,
  interestId,
  offer,
  onClose,
}: {
  userId: string;
  interestId: string;
  offer: PriceHistoryRow;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const form = `price-watch-create:${interestId}:${offer.offer_id}`;
  const [draft, setDraft] = useDraftState(form, { amount: offer.amount, maxAgeMinutes: 60 });
  const save = useMutation({
    mutationFn: () =>
      priceWatchApi.create({
        interest_id: interestId,
        offer_id: offer.offer_id,
        target_amount: draft.amount,
        max_age_seconds: draft.maxAgeMinutes * 60,
      }),
    onSuccess: async () => {
      clearFormDraft(form, userId);
      await client.invalidateQueries({ queryKey: ["price-watches", userId] });
      onClose();
    },
  });
  return (
    <form
      className="panel mt-2"
      aria-label="목표가 설정"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h4>선택한 판매 조건의 목표가</h4>
      <DraftRecoveryButton form={form} />
      <p>
        {offer.source_name} · {String(offer.facts.volume_ml ?? "미확인")} ml ·{" "}
        {String(offer.facts.units ?? "미확인")}개
      </p>
      <p className="muted text-sm">{conditionText(offer.facts)}</p>
      <p className="notice">
        등록하면 수동 조회만 사용합니다. 정기 조회와 웹 푸시는 가격 감시 화면에서 각각 선택하세요.
        알림을 받으려면 관심 대상의 외부 상품도 먼저 고정해야 합니다.
      </p>
      <div className="field">
        <label htmlFor={`watch-amount-${offer.offer_id}`}>목표가 ({offer.currency})</label>
        <input
          id={`watch-amount-${offer.offer_id}`}
          type="number"
          min="0"
          step="0.0001"
          required
          value={draft.amount}
          onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`watch-age-${offer.offer_id}`}>가격 유효 시간 (분)</label>
        <input
          id={`watch-age-${offer.offer_id}`}
          type="number"
          min="1"
          max="1440"
          required
          value={draft.maxAgeMinutes}
          onChange={(event) => setDraft({ ...draft, maxAgeMinutes: Number(event.target.value) })}
        />
      </div>
      {save.isError && (
        <p className="alert" role="alert">
          {save.error.message}
        </p>
      )}
      <div className="button-row">
        <button className="primary" disabled={save.isPending} type="submit">
          목표가 저장
        </button>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </form>
  );
}
