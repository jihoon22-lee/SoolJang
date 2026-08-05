/**
 * 파생 지표 계산 — `src/sooljang/domain/metrics.py` 의 TypeScript 포팅.
 *
 * 오프라인 상태에서도 제품 목록·통계 화면을 보여주려면(사용자가 선택한 "전체 컬렉션
 * 오프라인 탐색" 범위) Dexie 미러의 원자값으로 같은 공식을 다시 계산해야 한다. Dexie 는
 * 원자값만 저장하고 파생 지표는 저장하지 않는다 — 이 원칙은 서버와 동일하다.
 *
 * Python 쪽엔 이미 domain(순수 함수) vs SQL 의 2-way parity 테스트가 있다(Task 8). 여기
 * TS 구현이 3번째로 더해지므로, `tests/fixtures/metrics_cases.json` 공유 골든값을 통해
 * 세 구현이 갈라지지 않는지 확인한다(`web/src/domain/metrics.test.ts`,
 * `tests/domain/test_metrics.py::test_price_metrics_matches_shared_fixture`).
 *
 * **핵심 규칙 세 가지** (Python 원본과 동일):
 * 1. 100ml당 가격은 정가 기준이다
 * 2. 가격이 없는 구매 건(선물)은 금액 집계에서 제외하되 병수 집계에는 포함한다
 * 3. 여러 용량이 섞인 제품은 가중 평균으로 계산한다
 *
 * `consumption_rate_per_month`·`krw_from_foreign` 은 포팅하지 않았다 — 오프라인 화면
 * 어디에서도 쓰지 않는다. 필요해지면 그때 추가한다. `value_for_money` 는 Task 20 에서
 * 제품 지표에 노출하며 포팅했다.
 */

import Decimal from "decimal.js";

const MONEY_DECIMALS = 2;
const RATIO_DECIMALS = 4;
const ML_PER_UNIT = 100;

export function quantizeMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_DECIMALS, Decimal.ROUND_HALF_UP);
}

export function quantizeRatio(value: Decimal): Decimal {
  return value.toDecimalPlaces(RATIO_DECIMALS, Decimal.ROUND_HALF_UP);
}

/**
 * 가성비. 100ml당 가격 1,000원 기준으로 정규화해 값이 너무 작아지지 않게 한다(Task 20).
 *
 * 높을수록 좋다. 가격이 0 이하이면 정의되지 않는다.
 * `src/sooljang/domain/metrics.py::value_for_money` 와 같은 공식이다.
 */
export function valueForMoney(
  rating: Decimal | null,
  pricePer100ml: Decimal | null,
): Decimal | null {
  if (rating === null || pricePer100ml === null || pricePer100ml.lessThanOrEqualTo(0)) {
    return null;
  }
  return quantizeRatio(rating.times(1000).dividedBy(pricePer100ml));
}

export const BottleState = {
  UNOPENED: "unopened",
  OPEN: "open",
  FINISHED: "finished",
  GIFTED: "gifted",
  SOLD: "sold",
} as const;

export const IN_STOCK_STATES: ReadonlySet<string> = new Set([
  BottleState.UNOPENED,
  BottleState.OPEN,
]);
export const DISPOSED_STATES: ReadonlySet<string> = new Set([BottleState.GIFTED, BottleState.SOLD]);

export interface PurchaseLot {
  quantity: number;
  volumeMl: number;
  unitListPrice: Decimal | null;
  unitPaidPrice: Decimal | null;
}

/** 구매 건 하나를 만든다. Python `PurchaseLot.__post_init__` 과 같은 검증을 한다. */
export function purchaseLot(
  quantity: number,
  volumeMl: number,
  unitListPrice: Decimal | null = null,
  unitPaidPrice: Decimal | null = null,
): PurchaseLot {
  if (quantity <= 0) throw new RangeError(`구매 병수는 양수여야 합니다: ${quantity}`);
  if (volumeMl <= 0) throw new RangeError(`용량은 양수여야 합니다: ${volumeMl}`);
  return { quantity, volumeMl, unitListPrice, unitPaidPrice };
}

function lotListTotal(lot: PurchaseLot): Decimal | null {
  return lot.unitListPrice === null ? null : lot.unitListPrice.times(lot.quantity);
}

function lotPaidTotal(lot: PurchaseLot): Decimal | null {
  return lot.unitPaidPrice === null ? null : lot.unitPaidPrice.times(lot.quantity);
}

function lotTotalVolumeMl(lot: PurchaseLot): number {
  return lot.volumeMl * lot.quantity;
}

export interface BottleRecord {
  status: string;
  openedOn: string | null;
  finishedOn: string | null;
}

export function bottleInStock(bottle: BottleRecord): boolean {
  return IN_STOCK_STATES.has(bottle.status);
}

export interface BottleTally {
  unopened: number;
  open: number;
  finished: number;
  gifted: number;
  sold: number;
}

const TALLY_STATUSES = ["unopened", "open", "finished", "gifted", "sold"] as const;

export function tallyBottles(bottles: Iterable<BottleRecord>): BottleTally {
  const tally: BottleTally = { unopened: 0, open: 0, finished: 0, gifted: 0, sold: 0 };
  for (const bottle of bottles) {
    if ((TALLY_STATUSES as readonly string[]).includes(bottle.status)) {
      tally[bottle.status as keyof BottleTally] += 1;
    }
  }
  return tally;
}

export function bottleTallyInStock(tally: BottleTally): number {
  return tally.unopened + tally.open;
}

export function bottleTallyDisposed(tally: BottleTally): number {
  return tally.gifted + tally.sold;
}

export function bottleTallyTotal(tally: BottleTally): number {
  return bottleTallyInStock(tally) + tally.finished + bottleTallyDisposed(tally);
}

export interface PriceMetrics {
  purchasedCount: number;
  pricedQuantity: number;
  paidQuantity: number;
  listTotal: Decimal | null;
  paidTotal: Decimal | null;
  avgListPrice: Decimal | null;
  avgPaidPrice: Decimal | null;
  pricePer100ml: Decimal | null;
  pricePer100mlPaid: Decimal | null;
  discountRate: Decimal | null;
  totalVolumeMl: number;
  /**
   * 통계 대시보드의 주종별·전체 집계가 제품 단위 가중 평균을 그룹 단위로 다시 계산할 때
   * 쓴다(`metrics_sql.py::product_price_metrics_query` 의 같은 이름 컬럼과 대응). 개별
   * 제품 지표 표시에는 쓰지 않는다.
   */
  listVolume: number;
  discountListTotal: Decimal | null;
  discountPaidTotal: Decimal | null;
}

export function priceMetricsHasPrices(metrics: PriceMetrics): boolean {
  return metrics.avgListPrice !== null || metrics.avgPaidPrice !== null;
}

interface WeightedTotal {
  amount: Decimal | null;
  quantity: number;
  volume: number;
}

/** 가격이 있는 구매 건만 합산한다. 금액이 있는 건이 없으면 `amount` 는 null 이다. */
function weightedTotal(lots: readonly PurchaseLot[], paid: boolean): WeightedTotal {
  let amount = new Decimal(0);
  let quantity = 0;
  let volume = 0;
  let found = false;
  for (const lot of lots) {
    const total = paid ? lotPaidTotal(lot) : lotListTotal(lot);
    if (total === null) continue;
    found = true;
    amount = amount.plus(total);
    quantity += lot.quantity;
    volume += lotTotalVolumeMl(lot);
  }
  return { amount: found ? amount : null, quantity, volume };
}

interface DiscountTotals {
  listAmount: Decimal | null;
  paidAmount: Decimal | null;
}

/** 정가와 실구매가가 모두 있는 구매 건만의 금액 합계. 할인율 분자·분모다. */
function discountTotalsOf(lots: readonly PurchaseLot[]): DiscountTotals {
  let listAmount = new Decimal(0);
  let paidAmount = new Decimal(0);
  let found = false;
  for (const lot of lots) {
    if (lot.unitListPrice === null || lot.unitPaidPrice === null) continue;
    found = true;
    listAmount = listAmount.plus(lot.unitListPrice.times(lot.quantity));
    paidAmount = paidAmount.plus(lot.unitPaidPrice.times(lot.quantity));
  }
  return found ? { listAmount, paidAmount } : { listAmount: null, paidAmount: null };
}

/** 할인율. 정가와 실구매가가 모두 있는 구매 건만으로 계산한다. */
function discountRateOf(totals: DiscountTotals): Decimal | null {
  if (totals.listAmount === null || totals.paidAmount === null || totals.listAmount.isZero()) {
    return null;
  }
  return quantizeRatio(new Decimal(1).minus(totals.paidAmount.dividedBy(totals.listAmount)));
}

export function computePriceMetrics(lots: readonly PurchaseLot[]): PriceMetrics {
  const purchasedCount = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const totalVolumeMl = lots.reduce((sum, lot) => sum + lotTotalVolumeMl(lot), 0);

  const list = weightedTotal(lots, false);
  const paid = weightedTotal(lots, true);

  const avgListPrice =
    list.amount !== null && list.quantity > 0
      ? quantizeMoney(list.amount.dividedBy(list.quantity))
      : null;
  const avgPaidPrice =
    paid.amount !== null && paid.quantity > 0
      ? quantizeMoney(paid.amount.dividedBy(paid.quantity))
      : null;
  // 여러 용량이 섞이면 가중 평균이어야 한다. 단일 용량이면 avg / (volume/100) 과 같다.
  const pricePer100ml =
    list.amount !== null && list.volume > 0
      ? quantizeMoney(list.amount.times(ML_PER_UNIT).dividedBy(list.volume))
      : null;
  const pricePer100mlPaid =
    paid.amount !== null && paid.volume > 0
      ? quantizeMoney(paid.amount.times(ML_PER_UNIT).dividedBy(paid.volume))
      : null;

  const discountTotals = discountTotalsOf(lots);

  return {
    purchasedCount,
    pricedQuantity: list.quantity,
    paidQuantity: paid.quantity,
    listTotal: list.amount,
    paidTotal: paid.amount,
    avgListPrice,
    avgPaidPrice,
    pricePer100ml,
    pricePer100mlPaid,
    discountRate: discountRateOf(discountTotals),
    totalVolumeMl,
    listVolume: list.volume,
    discountListTotal: discountTotals.listAmount,
    discountPaidTotal: discountTotals.paidAmount,
  };
}

export interface ProductMetrics {
  prices: PriceMetrics;
  bottles: BottleTally;
  inventoryValueAtCost: Decimal | null;
  averageDaysToFinish: Decimal | null;
  consistencyWarnings: string[];
}

/** ISO 날짜(`YYYY-MM-DD`) 두 값 사이의 일수. UTC 자정 기준으로 시간대 오차를 피한다. */
function daysBetween(openedOn: string, finishedOn: string): number {
  const start = Date.parse(`${openedOn}T00:00:00Z`);
  const end = Date.parse(`${finishedOn}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * 개봉→소진 평균 일수. 개봉일·소진일이 모두 있는 병만의 평균이다.
 *
 * 제품 하나(`computeProductMetrics`)뿐 아니라 컬렉션 전체(통계 요약)에도 그대로 쓴다 —
 * 병 목록을 평평하게 모아 넘기기만 하면 되므로 별도 컬렉션 버전을 만들 필요가 없다. 제품별
 * 평균을 다시 평균 내면(표본 크기를 무시하게 돼) 병이 적은 제품과 많은 제품이 똑같이
 * 반영되는 왜곡이 생긴다 — 항상 병 단위로 직접 평균한다.
 */
export function averageDaysToFinish(bottles: readonly BottleRecord[]): Decimal | null {
  const durations = bottles
    .filter((b): b is BottleRecord & { openedOn: string; finishedOn: string } =>
      Boolean(b.openedOn && b.finishedOn),
    )
    .map((b) => daysBetween(b.openedOn, b.finishedOn));
  if (durations.length === 0) return null;
  return quantizeRatio(
    durations.reduce((sum, d) => sum.plus(d), new Decimal(0)).dividedBy(durations.length),
  );
}

export function computeProductMetrics(
  lots: readonly PurchaseLot[],
  bottles: readonly BottleRecord[],
): ProductMetrics {
  const prices = computePriceMetrics(lots);
  const tally = tallyBottles(bottles);

  const warnings: string[] = [];
  const bottleCount = bottleTallyTotal(tally);
  if (bottleCount !== prices.purchasedCount) {
    warnings.push(`병 레코드 수(${bottleCount})가 구매 병수(${prices.purchasedCount})와 다릅니다`);
  }

  const inventoryValueAtCost =
    prices.avgPaidPrice !== null
      ? quantizeMoney(prices.avgPaidPrice.times(bottleTallyInStock(tally)))
      : null;

  return {
    prices,
    bottles: tally,
    inventoryValueAtCost,
    averageDaysToFinish: averageDaysToFinish(bottles),
    consistencyWarnings: warnings,
  };
}
