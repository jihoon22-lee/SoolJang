/**
 * 매장 모드의 관심 목록·목표가(F1).
 *
 * 매장에서 "사려던 술인지, 목표가가 얼마였는지"를 바로 확인하게 한다. 온라인이면 관심과 가격
 * 감시를 받아 계정 저장본을 새로 쓰고, 화면은 언제나 저장본을 읽는다. 오프라인에서는 저장 시각을
 * 함께 보여 오래된 목록임을 알린다. 읽기 전용이다.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { interestsApi } from "@/api/interests";
import { priceWatchApi } from "@/api/priceWatch";
import { formatMoney } from "@/format";
import { matchesQuery } from "@/search";
import { databaseIdentity } from "@/sync/db";
import {
  buildInterestSnapshot,
  type SnapshotInterest,
  saveInterestSnapshot,
  useInterestSnapshot,
} from "@/sync/interestSnapshot";

const MAX_RESULTS = 8;

function targetText(item: SnapshotInterest): string {
  if (!item.targets.length) return "목표가 없음";
  return item.targets
    .map((target) => {
      const amount =
        target.currency === "KRW"
          ? formatMoney(target.amount)
          : `${target.amount} ${target.currency}`;
      // 목표가는 감시한 용량 기준이다. 관심의 다른 용량과 섞어 읽지 않게 함께 적는다.
      const basis = [target.volumeMl ? `${Number(target.volumeMl)}ml` : null, target.source]
        .filter(Boolean)
        .join(", ");
      return `목표 ${amount} (${basis})`;
    })
    .join(" · ");
}

export function StoreModeInterests({ query, offline }: { query: string; offline: boolean }) {
  const userId = databaseIdentity().userId;
  const interests = useQuery({
    queryKey: ["interests"],
    queryFn: interestsApi.list,
    enabled: !offline,
  });
  const watches = useQuery({
    queryKey: ["price-watches", userId],
    queryFn: ({ signal }) => priceWatchApi.list(undefined, signal),
    enabled: !offline && Boolean(userId),
  });
  useEffect(() => {
    if (!interests.data || !watches.data) return;
    const owner = databaseIdentity();
    // 받는 동안 계정이 바뀌었으면 다른 계정의 목록을 이 계정 저장본에 쓰지 않는다.
    if (owner.userId !== userId) return;
    // 캐시로 다시 그린 목록이 방금 받은 것처럼 보이지 않게 실제로 받은 시각 중 이른 쪽을 쓴다.
    const fetchedAt = new Date(Math.min(interests.dataUpdatedAt, watches.dataUpdatedAt));
    void saveInterestSnapshot(buildInterestSnapshot(interests.data, watches.data, fetchedAt));
  }, [interests.data, interests.dataUpdatedAt, watches.data, watches.dataUpdatedAt, userId]);

  const saved = useInterestSnapshot();
  // 이번에 받은 목록이 있으면 그것을, 없거나(오프라인·실패·받는 중) 아직이면 저장본을 보인다.
  const live = !offline && interests.isSuccess && watches.isSuccess;
  const snapshot = live
    ? buildInterestSnapshot(
        interests.data,
        watches.data,
        new Date(Math.min(interests.dataUpdatedAt, watches.dataUpdatedAt)),
      )
    : saved;
  if (!snapshot) {
    return offline ? (
      <p className="muted text-sm">
        관심 목록은 한 번 온라인에서 매장 모드를 연 뒤부터 오프라인에서도 볼 수 있습니다.
      </p>
    ) : null;
  }
  const trimmed = query.trim();
  const matching = trimmed
    ? snapshot.interests.filter((item) =>
        [item.name, item.nameEn ?? "", ...item.aliases].some((name) => matchesQuery(name, trimmed)),
      )
    : snapshot.interests;
  const stale = live
    ? ""
    : ` · ${offline ? "오프라인 " : ""}저장본(${new Date(snapshot.savedAt).toLocaleString("ko-KR")} 기준)`;
  if (trimmed && matching.length === 0) return null;

  const list = (
    <ul className="store-mode-interests">
      {matching.slice(0, MAX_RESULTS).map((item) => (
        <li key={item.id}>
          <span className="name">{item.name}</span>
          <span className="muted text-sm">
            {[item.volumesMl.length ? `${item.volumesMl.join(" / ")}ml` : "", targetText(item)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
  return trimmed ? (
    <section aria-labelledby="store-mode-interest-heading" className="mt-3">
      <h3 id="store-mode-interest-heading">관심 목록에 있는 술</h3>
      <p className="muted text-sm">사려고 저장한 관심입니다{stale}.</p>
      {list}
    </section>
  ) : (
    <details className="panel mt-3">
      <summary>
        관심 목록 {snapshot.interests.length}개{stale}
      </summary>
      {snapshot.interests.length ? list : <p className="muted">저장한 관심이 없습니다.</p>}
      {snapshot.interests.length > MAX_RESULTS ? (
        <p className="muted text-sm">이름을 검색하면 나머지 관심도 함께 찾습니다.</p>
      ) : null}
    </details>
  );
}
