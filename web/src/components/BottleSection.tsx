/**
 * 제품 상세의 병 목록 — 한 병씩 펼쳐 보거나, 여러 병을 골라 한 번에 처리한다.
 *
 * 6병 박스를 한 번에 소진·증여하려고 병마다 펼치고 버튼을 누르던 흐름을 줄인다. 상태
 * 전이는 병마다 outbox 명령 하나라 오프라인에서도 되고, 처리 직후 "실행 취소"로 역방향
 * 전이를 보낸다. 보관 위치 이동은 서버의 위치 기록을 쓰므로 온라인에서만 한다.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { collectionApi } from "@/api/collection";
import type { Bottle, BottleStatus, Product, Purchase } from "@/api/types";
import { BottlePanel, formatRemaining, STATUS_LABELS } from "@/components/BottlePanel";
import { type HandOverAction, HandOverSheet } from "@/components/HandOverSheet";
import { productEdition, purchaseReference } from "@/components/productDisplay";
import { useToast } from "@/components/Toast";
import { formatDate, formatVolume } from "@/format";
import type { ProductContext } from "@/router";
import {
  applyBottleTransitions,
  type BulkTransitionResult,
  canTransition,
  type TransitionAction,
  type TransitionOptions,
  undoBottleTransitions,
} from "@/sync/bottleActions";

const IN_STOCK: readonly BottleStatus[] = ["unopened", "open"];

const ACTION_LABELS: Partial<Record<TransitionAction, string>> = {
  open: "개봉",
  finish: "소진",
  gift: "증여",
  sell: "판매",
};

/** 지난 병(소진·증여·판매)이 이보다 많으면 접어 둔다. 지금 마실 수 있는 병이 먼저 보이게. */
const PAST_VISIBLE_LIMIT = 3;

export function BottleSection({
  product,
  selectedSkuId,
  selectedBottleId,
  selectedTastingId,
  onSelectContext,
  onSavingChange,
  bottles,
  purchases,
  offline,
}: {
  product?: Product | undefined;
  selectedSkuId?: string | undefined;
  selectedBottleId?: string | undefined;
  selectedTastingId?: string | undefined;
  onSelectContext?: ((context: ProductContext) => void) | undefined;
  onSavingChange?: ((saving: boolean) => void) | undefined;
  bottles: Bottle[];
  purchases: Purchase[];
  offline: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [localExpandedId, setExpandedId] = useState<string | null>(null);
  const expandedId = selectedBottleId ?? localExpandedId;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [handOver, setHandOver] = useState<HandOverAction | null>(null);
  const [moving, setMoving] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingBottleId, setSavingBottleId] = useState<string | null>(null);
  const savingBottle = savingBottleId !== null && savingBottleId === expandedId;
  const [error, setError] = useState<string | null>(null);

  const purchaseById = useMemo(
    () => new Map(purchases.map((purchase) => [purchase.id, purchase])),
    [purchases],
  );
  // 구매가 여러 건이면 번호만으로는 어느 병인지 모른다 — 구매일·구매처를 함께 보인다.
  const visibleBottles = useMemo(
    () =>
      selectedSkuId
        ? bottles.filter((bottle) => purchaseById.get(bottle.purchase_id)?.sku_id === selectedSkuId)
        : bottles,
    [bottles, purchaseById, selectedSkuId],
  );
  const purchaseIds = purchases.map((purchase) => purchase.id);
  function bottleContext(bottle: Bottle): string {
    const purchase = purchaseById.get(bottle.purchase_id);
    const sku = product?.skus.find((sku) => sku.id === purchase?.sku_id);
    return [
      formatVolume(purchase?.volume_ml ?? sku?.volume_ml),
      product ? productEdition(product) : null,
      purchase ? formatDate(purchase.purchased_on) : null,
      purchase?.vendor_name ?? "구매처 미기록",
      purchaseReference(bottle.purchase_id, purchaseIds),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  function actionContext(bottle: Bottle): string {
    const purchase = purchaseById.get(bottle.purchase_id);
    const sku = product?.skus.find((sku) => sku.id === purchase?.sku_id);
    return `${formatVolume(purchase?.volume_ml ?? sku?.volume_ml)} · ${purchaseReference(bottle.purchase_id, purchaseIds)}`;
  }
  function expandBottle(bottle: Bottle): void {
    if (savingBottle) return;
    const next = expandedId === bottle.id ? null : bottle.id;
    if (onSelectContext)
      onSelectContext({
        ...(selectedSkuId ? { skuId: selectedSkuId } : {}),
        ...(next ? { bottleId: next } : {}),
      });
    else setExpandedId(next);
  }

  const locations = useQuery({
    queryKey: ["collection", "locations"],
    queryFn: collectionApi.locations,
    enabled: moving && !offline,
  });

  // 재고(미개봉·개봉)를 먼저, 그다음 지난 병. 같은 묶음에서는 구매일·번호 순.
  const sorted = useMemo(() => {
    const order = (bottle: Bottle) => (IN_STOCK.includes(bottle.status) ? 0 : 1);
    const day = (bottle: Bottle) => purchaseById.get(bottle.purchase_id)?.purchased_on ?? "";
    return [...visibleBottles].sort(
      (a, b) =>
        order(a) - order(b) ||
        day(a).localeCompare(day(b)) ||
        a.label_no - b.label_no ||
        a.id.localeCompare(b.id),
    );
  }, [visibleBottles, purchaseById]);
  const inStock = sorted.filter((bottle) => IN_STOCK.includes(bottle.status));
  const past = sorted.filter((bottle) => !IN_STOCK.includes(bottle.status));
  const visiblePast =
    showPast || past.length <= PAST_VISIBLE_LIMIT
      ? past
      : past.filter((bottle) => bottle.id === expandedId);

  // 목록이 바뀌면(동기화·삭제) 사라진 병은 선택에서 뺀다.
  const liveSelected = useMemo(
    () => new Set([...selected].filter((id) => visibleBottles.some((bottle) => bottle.id === id))),
    [selected, visibleBottles],
  );
  const selectedBottles = visibleBottles.filter((bottle) => liveSelected.has(bottle.id));
  const possible = (action: TransitionAction) =>
    selectedBottles.filter((bottle) => canTransition(bottle.status, action)).length;

  if (visibleBottles.length === 0) {
    return (
      <>
        <h3>병</h3>
        <output className="notice">
          등록된 병이 없습니다. 구매 건을 추가하면 병이 자동으로 만들어집니다.
        </output>
      </>
    );
  }

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function finishSelection(): void {
    setSelecting(false);
    setSelected(new Set());
    setHandOver(null);
    setMoving(false);
  }

  async function run(
    action: TransitionAction,
    options: TransitionOptions = {},
    ids: readonly string[] = [...liveSelected],
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result: BulkTransitionResult = await applyBottleTransitions(ids, action, options);
      const label = ACTION_LABELS[action] ?? "처리";
      const skipped = result.skipped.length;
      toast.show({
        message:
          `${result.applied.length}병 ${label} 처리` +
          (skipped > 0 ? ` · ${skipped}병은 지금 상태에서 할 수 없어 건너뜀` : ""),
        tone: skipped > 0 ? "warn" : "info",
        ...(result.applied.length > 0
          ? {
              actionLabel: "실행 취소",
              onAction: async () => {
                const undone = await undoBottleTransitions(result.applied);
                toast.show({
                  message:
                    `${undone.applied.length}병 취소 기록 저장` +
                    (undone.skipped.length
                      ? ` · ${undone.skipped.length}병은 이후 변경이 있어 유지했습니다`
                      : ""),
                  tone: undone.skipped.length ? "warn" : "info",
                });
              },
            }
          : {}),
      });
      finishSelection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "상태를 바꾸지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function moveTo(locationId: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ids = [...liveSelected];
      const before = await collectionApi.bottles();
      const previous = new Map(before.map((row) => [row.id, row.location_id]));
      const result = await collectionApi.moveMany(ids, locationId);
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      const name =
        locationId === null
          ? "미지정"
          : (locations.data?.find((row) => row.id === locationId)?.name ?? "선택한 위치");
      toast.show({
        message: `${result.moved}병을 ${name}(으)로 옮겼습니다`,
        actionLabel: "실행 취소",
        onAction: async () => {
          // 원래 위치별로 묶어 되돌린다.
          const groups = new Map<string | null, string[]>();
          for (const id of ids) {
            const from = previous.get(id) ?? null;
            groups.set(from, [...(groups.get(from) ?? []), id]);
          }
          for (const [from, group] of groups) await collectionApi.moveMany(group, from);
          void queryClient.invalidateQueries({ queryKey: ["collection"] });
          toast.show({ message: "보관 위치를 되돌렸습니다" });
        },
      });
      finishSelection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "위치를 옮기지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  // 가장 자주 하는 두 가지는 병을 고르지 않고 바로 한다.
  const nextToOpen = inStock.find((bottle) => bottle.status === "unopened");
  const oldestOpen = [...inStock]
    .filter((bottle) => bottle.status === "open")
    .sort((a, b) => (a.opened_on ?? "").localeCompare(b.opened_on ?? ""))[0];

  function renderRow(bottle: Bottle) {
    const context = bottleContext(bottle);
    const summary = (
      <>
        <span className="bottle-list-label">
          {bottle.label_no}번 병{context ? <span className="muted"> · {context}</span> : null}
        </span>
        <span className={`bottle-badge bottle-badge-${bottle.status}`}>
          {STATUS_LABELS[bottle.status]}
        </span>
        <span className="bottle-list-remaining">{formatRemaining(bottle)}</span>
      </>
    );
    if (selecting) {
      return (
        <li key={bottle.id}>
          <label className="bottle-row bottle-list-item">
            <input
              type="checkbox"
              checked={liveSelected.has(bottle.id)}
              onChange={() => toggle(bottle.id)}
            />
            {summary}
          </label>
        </li>
      );
    }
    return (
      <li key={bottle.id}>
        <button
          type="button"
          className="bottle-list-item"
          aria-expanded={expandedId === bottle.id}
          disabled={savingBottle}
          onClick={() => expandBottle(bottle)}
        >
          {summary}
        </button>
        {expandedId === bottle.id ? (
          <BottlePanel
            key={bottle.id}
            bottle={bottle}
            offline={offline}
            contextLabel={context}
            selectedTastingId={selectedTastingId}
            onSavingChange={(saving) => {
              setSavingBottleId(saving ? bottle.id : null);
              onSavingChange?.(saving);
            }}
          />
        ) : null}
      </li>
    );
  }

  return (
    <section className="bottle-section" aria-labelledby="bottle-section-heading">
      <div className="section-heading-row">
        <h3 id="bottle-section-heading">
          병 {visibleBottles.length}개 <span className="muted">· 재고 {inStock.length}</span>
        </h3>
        <button
          type="button"
          aria-pressed={selecting}
          disabled={savingBottle}
          onClick={() => (selecting ? finishSelection() : setSelecting(true))}
        >
          {selecting ? "선택 끝내기" : "여러 병 선택"}
        </button>
      </div>

      {!selecting && (nextToOpen || oldestOpen) ? (
        <div className="button-row quick-actions">
          {nextToOpen ? (
            <button
              type="button"
              disabled={busy || savingBottle}
              onClick={() => void run("open", {}, [nextToOpen.id])}
            >
              한 병 개봉 ({nextToOpen.label_no}번 · {actionContext(nextToOpen)})
            </button>
          ) : null}
          {oldestOpen ? (
            <button
              type="button"
              disabled={busy || savingBottle}
              onClick={() => void run("finish", {}, [oldestOpen.id])}
            >
              개봉한 병 다 마심 ({oldestOpen.label_no}번 · {actionContext(oldestOpen)})
            </button>
          ) : null}
        </div>
      ) : null}

      {selecting ? (
        <div className="selection-toolbar">
          <span>{liveSelected.size}병 선택됨</span>
          <button
            type="button"
            className="sort-button"
            onClick={() => setSelected(new Set(inStock.map((bottle) => bottle.id)))}
          >
            재고 전체 선택 ({inStock.length})
          </button>
          <button type="button" className="sort-button" onClick={() => setSelected(new Set())}>
            선택 해제
          </button>
        </div>
      ) : null}

      <ul className="bottle-list">{[...inStock, ...visiblePast].map(renderRow)}</ul>
      {past.length > PAST_VISIBLE_LIMIT ? (
        <button type="button" className="sort-button" onClick={() => setShowPast((v) => !v)}>
          {showPast ? "지난 병 접기" : `지난 병 ${past.length}개 보기`}
        </button>
      ) : null}

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {selecting && liveSelected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="선택한 병 처리">
          <span className="bulk-bar-count">{liveSelected.size}병</span>
          <button
            type="button"
            disabled={busy || possible("open") === 0}
            onClick={() => void run("open")}
          >
            개봉{possible("open") < liveSelected.size ? ` ${possible("open")}` : ""}
          </button>
          <button
            type="button"
            disabled={busy || possible("finish") === 0}
            onClick={() => void run("finish")}
          >
            소진{possible("finish") < liveSelected.size ? ` ${possible("finish")}` : ""}
          </button>
          <button
            type="button"
            disabled={busy || possible("gift") === 0}
            aria-expanded={handOver === "gift"}
            onClick={() => setHandOver("gift")}
          >
            증여
          </button>
          <button
            type="button"
            disabled={busy || possible("sell") === 0}
            aria-expanded={handOver === "sell"}
            onClick={() => setHandOver("sell")}
          >
            판매
          </button>
          <button
            type="button"
            disabled={busy || offline}
            aria-expanded={moving}
            title={offline ? "보관 위치는 온라인에서 옮길 수 있습니다" : undefined}
            onClick={() => setMoving((value) => !value)}
          >
            위치 이동
          </button>
        </div>
      ) : null}

      {selecting && handOver ? (
        <HandOverSheet
          action={handOver}
          count={possible(handOver)}
          pending={busy}
          onCancel={() => setHandOver(null)}
          onConfirm={({ on, note }) => void run(handOver, { on, note: note || undefined })}
        />
      ) : null}

      {selecting && moving ? (
        <fieldset className="sheet">
          <legend>보관 위치로 옮기기</legend>
          <p className="mt-0">
            {liveSelected.size}병을 옮길 위치를 고르세요. 이동 이력이 남습니다.
          </p>
          {locations.isPending ? <output>위치를 불러오는 중…</output> : null}
          <div className="button-row">
            {(locations.data ?? [])
              .filter((row) => !row.deleted)
              .map((row) => (
                <button
                  key={row.id}
                  type="button"
                  disabled={busy || savingBottle}
                  onClick={() => void moveTo(row.id)}
                >
                  {row.name}
                </button>
              ))}
            <button type="button" disabled={busy || savingBottle} onClick={() => void moveTo(null)}>
              미지정
            </button>
          </div>
          {locations.data && locations.data.filter((row) => !row.deleted).length === 0 ? (
            <p className="muted">
              보관 위치가 없습니다. 설정 → 보관·실사에서 위치를 먼저 만드세요.
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </section>
  );
}
