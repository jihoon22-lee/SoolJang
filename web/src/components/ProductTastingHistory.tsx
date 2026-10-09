import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { tastingsApi } from "@/api/client";
import type { ContextualTasting, TastingFilters } from "@/api/types";
import { productEdition, purchaseReference } from "@/components/productDisplay";
import { formatVolume } from "@/format";
import { databaseIdentity } from "@/sync/db";
import { useDraftState } from "@/sync/drafts";
import { getLocalTasting, getLocalTastingHistory } from "@/sync/tastingHistory";
import { captureWriteSession } from "@/sync/writeSession";

export interface ProductTastingHistoryProps {
  productId: string;
  selectedSkuId?: string | undefined;
  selectedBottleId?: string | undefined;
  selectedTastingId?: string | undefined;
  offline: boolean;
  correctionPending?: boolean | undefined;
  onCorrect: (tasting: ContextualTasting) => void;
  onSelectTasting?: ((tasting: ContextualTasting) => void) | undefined;
}

function contextLabel(item: ContextualTasting, purchaseIds: string[]): string {
  return [
    item.context.product_name,
    productEdition(item.context),
    formatVolume(item.context.volume_ml),
    item.bottle ? `${item.bottle.label_no}번 병` : "병 연결 없음",
    item.purchase ? purchaseReference(item.purchase.id, purchaseIds) : "구매 연결 없음",
    item.purchase?.purchased_on,
    item.purchase?.vendor_name,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 제품의 모든 시음을 찾는다. 서버 페이지와 기기에 저장된 기록의 범위를 구분한다. */
export function ProductTastingHistory({
  productId,
  selectedSkuId,
  selectedBottleId,
  selectedTastingId,
  offline,
  correctionPending = false,
  onCorrect,
  onSelectTasting,
}: ProductTastingHistoryProps) {
  const [session] = useState(captureWriteSession);
  const [identity] = useState(databaseIdentity);
  const queryClient = useQueryClient();
  const cursor = useLiveQuery(
    async () => (await session.store.sync_meta.get("cursor"))?.value ?? null,
    [session],
  );
  const previousCursor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (cursor === undefined) return;
    const previous = previousCursor.current;
    previousCursor.current = cursor;
    if (previous !== undefined && previous !== cursor && !offline)
      void queryClient.invalidateQueries({ queryKey: ["tastings"] });
  }, [cursor, offline, queryClient]);
  const [filter, setFilter] = useDraftState(`tasting-history:${productId}`, {
    skuId: selectedSkuId ?? "",
    bottleId: selectedBottleId ?? "",
    from: "",
    to: "",
  });
  const [localLimit, setLocalLimit] = useState(50);
  const [localRefresh, setLocalRefresh] = useState(0);
  const priorContext = useRef<{
    selectedSkuId: string | undefined;
    selectedBottleId: string | undefined;
  } | null>(null);
  useEffect(() => {
    const previous = priorContext.current;
    priorContext.current = { selectedSkuId, selectedBottleId };
    if (!previous && !selectedSkuId && !selectedBottleId) return;
    if (
      previous?.selectedSkuId === selectedSkuId &&
      previous?.selectedBottleId === selectedBottleId
    )
      return;
    setFilter((previous) => ({
      ...previous,
      skuId: selectedSkuId ?? "",
      bottleId: selectedBottleId ?? "",
    }));
  }, [selectedSkuId, selectedBottleId, setFilter]);
  const filters: TastingFilters = {
    product_id: productId,
    ...(filter.skuId ? { sku_id: filter.skuId } : {}),
    ...(filter.bottleId ? { bottle_id: filter.bottleId } : {}),
    ...(filter.from ? { tasted_on_min: filter.from } : {}),
    ...(filter.to ? { tasted_on_max: filter.to } : {}),
  };
  const filterKey = JSON.stringify(filters);
  const localCache = useRef<{
    key: string;
    data: Awaited<ReturnType<typeof getLocalTastingHistory>>;
  } | null>(null);
  useEffect(() => {
    void filterKey;
    setLocalLimit(50);
  }, [filterKey]);
  const local = useLiveQuery(async () => {
    try {
      const data = await getLocalTastingHistory(filters);
      session.assertCurrent();
      localCache.current = { key: filterKey, data };
      return { data, error: null };
    } catch (error) {
      return {
        data: localCache.current?.key === filterKey ? localCache.current.data : null,
        error,
      };
    }
  }, [filterKey, session, localRefresh]);
  const choices = useLiveQuery(async () => {
    try {
      const data = await getLocalTastingHistory({ product_id: productId });
      session.assertCurrent();
      return data.items;
    } catch {
      return [];
    }
  }, [productId, session, localRefresh]);
  const timeline = useInfiniteQuery({
    queryKey: ["tastings", "pages", identity.userId, identity.generation, filters],
    queryFn: async ({ pageParam, signal }) => {
      session.assertCurrent();
      const page = await tastingsApi.page({ ...filters, limit: 50, cursor: pageParam }, signal);
      session.assertCurrent();
      return page;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !offline,
  });
  const summary = useQuery({
    queryKey: ["tastings", "summary", identity.userId, identity.generation, filters],
    queryFn: async ({ signal }) => {
      session.assertCurrent();
      const result = await tastingsApi.summary(filters, signal);
      session.assertCurrent();
      return result;
    },
    enabled: !offline,
  });
  const target = useQuery({
    networkMode: offline ? "always" : "online",
    queryKey: [
      "tastings",
      "record",
      identity.userId,
      identity.generation,
      selectedTastingId,
      offline ? "local" : "server",
    ],
    queryFn: async ({ signal }) => {
      if (!selectedTastingId) return null;
      session.assertCurrent();
      const result = offline
        ? await getLocalTasting(selectedTastingId)
        : await tastingsApi.get(selectedTastingId, signal);
      session.assertCurrent();
      return result;
    },
    enabled: Boolean(selectedTastingId),
  });
  const onlineItems = [
    ...new Map(
      (timeline.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
    ).values(),
  ];
  const loadedItems = offline ? (local?.data?.items ?? []) : onlineItems;
  const visibleItems = offline ? loadedItems.slice(0, localLimit) : loadedItems;
  const pinned = target.data && !visibleItems.some((item) => item.id === target.data?.id);
  const items = pinned && target.data ? [target.data, ...visibleItems] : visibleItems;
  const allChoices = [...(choices ?? []), ...items];
  const skuChoices = [...new Map(allChoices.map((item) => [item.sku_id, item.context])).values()];
  const bottleChoices = [
    ...new Map(
      allChoices
        .filter((item) => item.bottle && (!filter.skuId || item.sku_id === filter.skuId))
        .map((item) => [item.bottle?.id, item]),
    ).values(),
  ];
  const purchaseIds = [
    ...new Set(allChoices.flatMap((item) => (item.purchase ? [item.purchase.id] : []))),
  ];
  const shownSummary = offline ? local?.data?.summary : summary.data;
  const selectedRef = useRef<HTMLLIElement>(null);
  const focused = useRef<string | undefined>(undefined);
  const targetShown = items.some((item) => item.id === selectedTastingId);
  useEffect(() => {
    if (!selectedTastingId) focused.current = undefined;
    if (!selectedTastingId || !targetShown || focused.current === selectedTastingId) return;
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
    selectedRef.current?.focus({ preventScroll: true });
    focused.current = selectedTastingId;
  }, [selectedTastingId, targetShown]);

  return (
    <section className="panel product-tasting-history" aria-label="제품 시음 이력">
      <h3>시음 이력 찾기</h3>
      <fieldset disabled={correctionPending}>
        <legend>시음 조회 조건</legend>
        <label>
          시음 규격
          <select
            aria-label="시음 규격"
            value={filter.skuId}
            onChange={(event) => setFilter({ ...filter, skuId: event.target.value, bottleId: "" })}
          >
            <option value="">전체 규격</option>
            {filter.skuId && !skuChoices.some((sku) => sku.sku_id === filter.skuId) ? (
              <option value={filter.skuId}>선택한 규격</option>
            ) : null}
            {skuChoices.map((sku) => (
              <option key={sku.sku_id} value={sku.sku_id}>
                {formatVolume(sku.volume_ml)}
              </option>
            ))}
          </select>
        </label>
        <label>
          시음 병
          <select
            aria-label="시음 병"
            value={filter.bottleId}
            onChange={(event) => setFilter({ ...filter, bottleId: event.target.value })}
          >
            <option value="">전체 병</option>
            {filter.bottleId &&
            !bottleChoices.some((item) => item.bottle?.id === filter.bottleId) ? (
              <option value={filter.bottleId}>선택한 병</option>
            ) : null}
            {bottleChoices.map((item) => (
              <option key={item.bottle?.id} value={item.bottle?.id}>
                {contextLabel(item, purchaseIds)}
              </option>
            ))}
          </select>
        </label>
        <div className="field-row">
          <label>
            시음 시작일
            <input
              type="date"
              value={filter.from}
              onChange={(event) => setFilter({ ...filter, from: event.target.value })}
            />
          </label>
          <label>
            시음 종료일
            <input
              type="date"
              value={filter.to}
              onChange={(event) => setFilter({ ...filter, to: event.target.value })}
            />
          </label>
        </div>
      </fieldset>
      {offline ? (
        <p className="muted">
          기기에 저장된 시음 기록입니다. 정정 저장은 온라인에서 할 수 있습니다.
        </p>
      ) : null}
      {shownSummary ? (
        <dl className="tasting-summary">
          <dt>조건 내 시음</dt>
          <dd>{shownSummary.session_count}회</dd>
          <dt>평균 평점</dt>
          <dd>{shownSummary.average_rating ?? "기록 없음"}</dd>
          <dt>총 따른 양</dt>
          <dd>{shownSummary.total_poured_ml.toLocaleString("ko-KR")}ml</dd>
        </dl>
      ) : null}
      {!offline && summary.isError ? (
        <p role="alert">시음 요약을 갱신하지 못했습니다. 기존 요약이 있으면 그대로 표시합니다.</p>
      ) : null}
      {offline && local === undefined ? <output>기기의 시음 기록을 불러오는 중…</output> : null}
      {offline && local?.error ? <p role="alert">기기의 시음 기록을 불러오지 못했습니다.</p> : null}
      {!offline && timeline.isPending ? <output>시음 기록을 불러오는 중…</output> : null}
      {!offline && timeline.isError && !timeline.data ? (
        <p role="alert">시음 기록을 불러오지 못했습니다.</p>
      ) : null}
      {!offline && timeline.isRefetchError ? (
        <p role="alert">최신 기록을 확인하지 못했습니다. 이미 읽은 기록을 표시합니다.</p>
      ) : null}
      <button
        type="button"
        disabled={correctionPending || (!offline && timeline.isFetching)}
        onClick={() => {
          if (offline) {
            setLocalRefresh((value) => value + 1);
            void target.refetch();
          } else {
            void timeline.refetch();
            void summary.refetch();
            if (selectedTastingId) void target.refetch();
          }
        }}
      >
        시음 이력 새로고침
      </button>
      {selectedTastingId && target.isPending ? <output>선택한 시음을 찾는 중…</output> : null}
      {selectedTastingId && (target.isError || (target.isSuccess && !target.data)) ? (
        <p role="alert">선택한 시음을 확인하지 못했습니다. 조회 조건의 기존 기록은 유지됩니다.</p>
      ) : null}
      {pinned ? (
        <p className="muted">
          선택한 시음은 조회 조건 또는 현재 페이지 밖에 있어 따로 표시합니다. 조건 요약에는 추가로
          합산하지 않습니다.
        </p>
      ) : null}
      <ul className="tasting-timeline">
        {items.map((item) => (
          <li
            key={item.id}
            id={`history-tasting-${item.id}`}
            className={item.id === selectedTastingId ? "tasting-selected" : undefined}
            ref={item.id === selectedTastingId ? selectedRef : undefined}
            tabIndex={item.id === selectedTastingId ? -1 : undefined}
            aria-current={item.id === selectedTastingId ? "true" : undefined}
          >
            <p>{contextLabel(item, purchaseIds)}</p>
            <p>
              {item.tasted_on} · {item.rating === null ? "평점 없음" : `${item.rating}점`}
              {item.poured_ml === null ? "" : ` · ${item.poured_ml}ml`}
            </p>
            {item.nose ? <p>향: {item.nose}</p> : null}
            {item.palate ? <p>맛: {item.palate}</p> : null}
            {item.finish ? <p>피니시: {item.finish}</p> : null}
            {item.note ? <p>메모: {item.note}</p> : null}
            {item.place || item.companions ? (
              <p>{[item.place, item.companions].filter(Boolean).join(" · ")}</p>
            ) : null}
            <div className="button-row">
              {onSelectTasting ? (
                <button
                  type="button"
                  disabled={correctionPending}
                  onClick={() => onSelectTasting(item)}
                >
                  이 시음의 병으로 이동
                </button>
              ) : null}
              <button type="button" disabled={correctionPending} onClick={() => onCorrect(item)}>
                시음 정정
              </button>
            </div>
          </li>
        ))}
      </ul>
      {((offline && local?.data) || (!offline && timeline.data)) && !items.length ? (
        <p className="muted">조건에 맞는 시음 기록이 없습니다.</p>
      ) : null}
      {!offline && timeline.isFetchNextPageError ? (
        <p role="alert">이전 기록을 더 불러오지 못했습니다. 이미 읽은 기록은 유지됩니다.</p>
      ) : null}
      {(offline ? loadedItems.length > localLimit : timeline.hasNextPage) ? (
        <button
          type="button"
          disabled={correctionPending || (!offline && timeline.isFetching)}
          onClick={() =>
            offline
              ? setLocalLimit((value) => value + 50)
              : void timeline.fetchNextPage({ cancelRefetch: false })
          }
        >
          {timeline.isFetchingNextPage && !offline
            ? "이전 기록 불러오는 중…"
            : timeline.isFetchNextPageError && !offline
              ? "이전 기록 다시 불러오기"
              : "이전 기록 더 보기"}
        </button>
      ) : null}
    </section>
  );
}
