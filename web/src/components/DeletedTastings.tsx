/**
 * 최근 삭제한 시음 기록과 복구.
 *
 * 시음 삭제 직후의 "기록 복구"는 60초 알림뿐이고 알림은 3개만 남는다. 놓친 기록을 30일 안에
 * 다시 찾을 수 있게 서버가 복구 가능하다고 판단한 삭제 기록만 보여 준다(잔량은 바꾸지 않는다).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, tastingsApi } from "@/api/client";
import type { DeletedTasting } from "@/api/types";
import { productEdition } from "@/components/productDisplay";
import { useToast } from "@/components/Toast";
import { formatVolume } from "@/format";
import { changeTastingVisibility } from "@/sync/tastingLifecycle";
import { captureWriteSession } from "@/sync/writeSession";

export function DeletedTastings({ online }: { online: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [session] = useState(captureWriteSession);
  // 같은 기록의 재시도는 같은 요청 id로 보내 서버가 한 번만 반영하게 한다.
  const [requests, setRequests] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deleted = useQuery({
    queryKey: ["tastings", "deleted"],
    queryFn: ({ signal }) => tastingsApi.deleted(signal),
    enabled: online,
  });

  async function restore(item: DeletedTasting) {
    const requestId = requests[item.id] ?? crypto.randomUUID();
    setRequests((current) => ({ ...current, [item.id]: requestId }));
    setBusyId(item.id);
    setError(null);
    try {
      const result = await changeTastingVisibility(
        item.id,
        { request_id: requestId, expected_updated_at: item.updated_at },
        "restore",
        session,
      );
      session.assertCurrent();
      toast.show({
        message: result.superseded
          ? "복구 요청 이후 기록이 다시 변경되었습니다. 최신 기록을 확인하세요."
          : "시음 기록을 복구했습니다. 병의 잔량은 바뀌지 않았습니다.",
      });
    } catch (cause) {
      if (!session.isCurrent()) return;
      if (cause instanceof ApiError && cause.status === 409) {
        // 그 사이 다른 곳에서 바뀐 기록이다. 새 버전으로 다시 고를 수 있게 요청 id를 버린다.
        setRequests(({ [item.id]: _, ...rest }) => rest);
      }
      setError(cause instanceof Error ? cause.message : "기록을 복구하지 못했습니다.");
    } finally {
      if (session.isCurrent()) {
        setBusyId(null);
        for (const key of ["tastings", "bottles", "products", "stats"])
          void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }

  const items = deleted.data ?? [];
  return (
    <section className="card" aria-labelledby="deleted-tastings-heading">
      <h2 id="deleted-tastings-heading">최근 삭제한 시음</h2>
      <p className="muted text-sm">
        30일 안에 지운 시음 중 제품·병이 남아 있는 기록입니다. 복구해도 병의 잔량은 바뀌지 않습니다.
      </p>
      {!online ? <p className="muted">온라인에서 확인할 수 있습니다.</p> : null}
      {deleted.error ? <p role="alert">{deleted.error.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {deleted.data && items.length === 0 ? (
        <p className="muted">최근 삭제한 시음이 없습니다.</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="quality-record-list">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                {[
                  item.context.product_name,
                  productEdition(item.context),
                  formatVolume(item.context.volume_ml),
                  item.bottle ? `${item.bottle.label_no}번 병` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="muted text-sm">
                {item.tasted_on} 마심 · {item.rating === null ? "평점 없음" : `${item.rating}점`}
                {item.poured_ml === null ? "" : ` · ${item.poured_ml}ml`} ·{" "}
                {new Date(item.deleted_at).toLocaleDateString("ko-KR")} 삭제
              </span>
              <button
                type="button"
                disabled={!online || busyId !== null}
                onClick={() => void restore(item)}
              >
                {busyId === item.id ? "복구 중…" : "복구"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
