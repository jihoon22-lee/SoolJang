import { useLiveQuery } from "dexie-react-hooks";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { BottleGauge } from "@/components/BottleGauge";
import {
  bottlePurchaseContext,
  bottlePurchaseIdentity,
  bottlePurchaseLabel,
  sameLookingBottleIds,
} from "@/components/drinkableBottleLabel";
import { productEdition, purchaseReferences } from "@/components/productDisplay";
import { QuickTastingSheet, type RecordedTasting } from "@/components/QuickTastingSheet";
import { LoadingState } from "@/components/StatusViews";
import { useToast } from "@/components/Toast";
import { daysSince } from "@/domain/openedShelfLife";
import { formatMoney, formatRating, formatVolume, todayLocal } from "@/format";
import type { ProductContext, View } from "@/router";
import {
  type DrinkableBottle,
  getDrinkableBottles,
  getRecentTastings,
  getStatsSummary,
} from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { writeViewState } from "@/viewState";

interface HomePageProps {
  onSelectProduct: (productId: string, context?: ProductContext) => void;
  /** "산 술 기록". 등록 폼을 연 내 술 화면으로 간다. */
  onRecordPurchase: () => void;
  /** 통계처럼 홈 밖의 화면으로 이동. */
  onNavigate: (view: View) => void;
}

const OPEN_PREVIEW = 5;
const RECENT_TASTINGS = 3;

/**
 * 홈. 앱을 열면 가장 먼저 보이는 화면이다(D265).
 *
 * 마신 술·산 술 기록 두 행동, 보유 요약 한 줄, 열린 병(잔량과 바로 한 잔 기록), 최근 시음만
 * 둔다. 주종별 보유와 랭킹은 통계, 관리 화면은 설정 메뉴에 있다. 오프라인에서도 봐야 하므로
 * 모두 Dexie 로컬 미러(`sync/queries.ts`)로 계산한다.
 */
export function HomePage({ onSelectProduct, onRecordPurchase, onNavigate }: HomePageProps) {
  const totals = useLiveQuery(() => getStatsSummary(), []);
  const recentTastings = useLiveQuery(() => getRecentTastings(RECENT_TASTINGS), []);
  const drinkable = useLiveQuery(() => getDrinkableBottles(), []);
  const { pendingCount, lastError } = useSyncStatus();
  const [showAllOpen, setShowAllOpen] = useState(false);
  const [sheet, setSheet] = useState<{ bottle?: DrinkableBottle } | null>(null);
  const toast = useToast();
  // 저장 알림의 "한 잔 더"는 이 화면의 시트를 연다. 홈을 떠나면 열 시트가 없으니 알림을 거둔다.
  const followUp = useRef<(() => void) | null>(null);
  useEffect(() => () => followUp.current?.(), []);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  // 기록으로 병이 소진되어 누른 "한 잔" 단추가 사라졌으면 주 행동으로 초점을 돌린다.
  const returnFocus = useMemo<RefObject<HTMLButtonElement | null>>(
    () => ({
      get current() {
        return trigger.current?.isConnected ? trigger.current : primaryAction.current;
      },
    }),
    [],
  );

  if (!totals || !recentTastings || !drinkable) {
    return <LoadingState label="불러오는 중…" />;
  }

  const openBottles = drinkable.filter((item) => item.status === "open");
  // 같은 이름·판본·용량의 열린 병은 번호로, 번호까지 같으면(다른 구매) 구매일·구매처로 구분해
  // 다른 병에 기록하지 않게 한다(D264).
  const numbered = sameLookingBottleIds(openBottles);
  const sameNumber = sameLookingBottleIds(openBottles, true);
  const references = purchaseReferences(openBottles.map(bottlePurchaseIdentity));
  const today = todayLocal();
  const count = (value: number) => `${value.toLocaleString("ko-KR")}병`;
  function openSheet(button: HTMLButtonElement, bottle?: DrinkableBottle) {
    // 새 기록을 시작하면 앞 기록의 이어가기는 거둔다(열린 시트 위에서 다른 병을 열지 않게).
    followUp.current?.();
    trigger.current = button;
    setSheet(bottle ? { bottle } : {});
  }
  function offerFollowUp({ tastingId, bottle, message, finished }: RecordedTasting) {
    // 다 마신 병의 행은 곧 목록에서 빠진다. 시트가 닫힐 때 아직 남은 그 "한 잔"에 초점을
    // 돌리면 행이 사라지며 초점을 잃으므로 주 행동으로 돌린다.
    if (finished) trigger.current = primaryAction.current;
    const context = { skuId: bottle.skuId, bottleId: bottle.bottleId, tastingId };
    followUp.current?.();
    followUp.current = toast.show({
      message,
      actions: [
        {
          label: "고치기",
          onAction: () => onSelectProduct(bottle.productId, { ...context, editTasting: true }),
        },
        ...(finished ? [] : [{ label: "한 잔 더", onAction: () => setSheet({ bottle }) }]),
        { label: "보기", onAction: () => onSelectProduct(bottle.productId, context) },
      ],
    });
  }

  return (
    <div className="home-page">
      <h2 className="sr-only">홈</h2>
      <div className="home-actions">
        <button
          ref={primaryAction}
          type="button"
          className="primary"
          onClick={(event) => openSheet(event.currentTarget)}
        >
          마신 술 기록
        </button>
        <button type="button" onClick={onRecordPurchase}>
          산 술 기록
        </button>
      </div>
      {sheet ? (
        <QuickTastingSheet
          initialBottle={sheet.bottle}
          onSelectProduct={onSelectProduct}
          returnFocusRef={returnFocus}
          onRecorded={offerFollowUp}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {pendingCount > 0 || lastError ? (
        <output className="home-notice">
          {lastError
            ? `동기화를 확인하세요: ${lastError}`
            : `서버로 보낼 기록 ${pendingCount}건이 기다리고 있습니다. 연결되면 자동으로 보냅니다.`}
        </output>
      ) : null}

      <section aria-labelledby="home-summary-heading" className="home-summary-section">
        <h3 id="home-summary-heading" className="sr-only">
          보유 요약
        </h3>
        <dl className="home-summary">
          <Metric label="현재 보유" value={count(totals.in_stock_count)} />
          <Metric label="미개봉" value={count(totals.unopened_count)} />
          <Metric label="개봉 중" value={count(totals.opened_count)} />
          <Metric label="재고 원가" value={formatMoney(totals.inventory_value_at_cost ?? null)} />
        </dl>
        {totals.purchased_count === 0 ? (
          <p className="muted">아직 기록한 술이 없습니다. 산 술 기록에서 첫 술을 등록하세요.</p>
        ) : null}
      </section>

      <section aria-labelledby="home-open-heading">
        <h3 id="home-open-heading">
          열린 병 <span className="muted">{count(openBottles.length)}</span>
        </h3>
        {openBottles.length === 0 ? (
          <p className="muted">열려 있는 병이 없습니다.</p>
        ) : (
          <ul className="home-bottle-list">
            {(showAllOpen ? openBottles : openBottles.slice(0, OPEN_PREVIEW)).map((item) => {
              const edition = productEdition({
                vintage: item.vintage,
                age_years: item.ageYears,
                abv: item.abv,
              });
              const detail = sameNumber.has(item.bottleId)
                ? bottlePurchaseContext(item, references)
                : null;
              return (
                <li key={item.bottleId}>
                  <BottleGauge
                    status={item.status}
                    remainingMl={item.remainingMl}
                    volumeMl={item.volumeMl}
                  />
                  <div className="home-bottle-text">
                    <button
                      type="button"
                      className="entity-link"
                      aria-label={`${item.productName} #${item.labelNo} · ${formatVolume(item.volumeMl)}${detail ? ` · ${detail}` : ""}`}
                      onClick={() =>
                        onSelectProduct(item.productId, {
                          skuId: item.skuId,
                          bottleId: item.bottleId,
                        })
                      }
                    >
                      {item.productName}
                    </button>
                    <span className="muted text-sm">
                      {[
                        detail
                          ? bottlePurchaseLabel(item, references)
                          : numbered.has(item.bottleId)
                            ? `#${item.labelNo}`
                            : null,
                        item.remainingMl !== null ? `${item.remainingMl}ml 남음` : "잔량 미기록",
                        item.openedOn
                          ? `개봉 후 ${daysSince(item.openedOn, today)}일 경과`
                          : "개봉일 미기록",
                        edition,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="home-pour"
                    aria-label={`${item.productName} #${item.labelNo}${detail ? ` · ${detail}` : ""} 한 잔 기록`}
                    onClick={(event) => openSheet(event.currentTarget, item)}
                  >
                    한 잔
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {openBottles.length > OPEN_PREVIEW ? (
          <button type="button" className="btn-quiet" onClick={() => setShowAllOpen(!showAllOpen)}>
            {showAllOpen ? "접기" : `전체 ${openBottles.length}병 보기`}
          </button>
        ) : null}
      </section>

      <div className="home-side">
        <section aria-labelledby="home-recent-heading">
          <h3 id="home-recent-heading">최근 시음</h3>
          {recentTastings.length === 0 ? (
            <p className="muted">아직 시음 기록이 없습니다.</p>
          ) : (
            <ul className="home-tasting-list">
              {recentTastings.map((tasting) => {
                const { record } = tasting;
                return (
                  <li key={tasting.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onSelectProduct(record.context.product_id, {
                          skuId: record.sku_id,
                          bottleId: record.bottle_id ?? undefined,
                          tastingId: record.id,
                        })
                      }
                    >
                      <span className="home-tasting-name">{record.context.product_name}</span>
                      <span className="home-tasting-rating">
                        {record.rating === null ? "평점 없음" : formatRating(record.rating)}
                      </span>
                      <span className="muted text-sm">
                        {[
                          record.tasted_on,
                          record.poured_ml === null ? null : `${record.poured_ml}ml`,
                          record.bottle ? `${record.bottle.label_no}번 병` : null,
                          // 같은 이름의 다른 빈티지·숙성을 구분한다(도수는 빼서 짧게 둔다).
                          productEdition({ ...record.context, abv: null }) || null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <button
          type="button"
          className="btn-quiet home-more"
          onClick={() => {
            writeViewState("stats:section", "categories");
            onNavigate("stats");
          }}
        >
          주종별 보유 보기
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
