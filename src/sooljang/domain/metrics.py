"""파생 지표 계산.

`docs/architecture.md` §3 의 수식을 순수 함수로 구현한다. SQLAlchemy·HTTP 를 import 하지
않으므로 DB 없이 단위 테스트할 수 있다. 같은 공식을 SQL 로도 구현하고
(`infrastructure/database/metrics_sql.py`) 두 결과가 일치하는지 테스트로 보장한다.

**파생값은 저장하지 않는다.** 저장하면 엑셀과 같은 불일치 문제가 재발한다(§9.5).

핵심 규칙 세 가지를 기억할 것.

1. **100ml당 가격은 정가 기준**이다. 레거시 통계와 일치시키기 위한 결정이며
   실구매 기준으로 계산하면 168건이 불일치한다(`docs/legacy-schema.md` §4.2)
2. **가격이 없는 구매 건(선물)은 금액 집계에서 제외**하되 병수 집계에는 포함한다.
   레거시에 정가 결측 33건, 실구매가 결측 34건이 있다
3. **여러 용량이 섞인 제품**의 100ml당 가격은 가중 평균으로 계산한다
"""

import datetime
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

#: 금액을 원 단위 소수 둘째 자리까지 유지한다. 표시 단계에서 반올림한다.
MONEY_QUANT = Decimal("0.01")
#: 비율(할인율 등)은 소수 넷째 자리까지 유지한다.
RATIO_QUANT = Decimal("0.0001")
#: 100ml 단위 환산 계수.
ML_PER_UNIT = Decimal(100)


def quantize_money(value: Decimal) -> Decimal:
    return value.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def quantize_ratio(value: Decimal) -> Decimal:
    return value.quantize(RATIO_QUANT, rounding=ROUND_HALF_UP)


class BottleState:
    """병 상태 문자열. 도메인 계층은 ORM enum 에 의존하지 않는다.

    도메인이 `infrastructure` 를 import 하면 의존 방향이 뒤집힌다. 값은 ORM 의
    `BottleStatus` 와 같게 유지하고, 어긋나면 테스트가 잡는다.
    """

    UNOPENED = "unopened"
    OPEN = "open"
    FINISHED = "finished"
    GIFTED = "gifted"
    SOLD = "sold"


IN_STOCK_STATES = frozenset({BottleState.UNOPENED, BottleState.OPEN})
DISPOSED_STATES = frozenset({BottleState.GIFTED, BottleState.SOLD})


@dataclass(frozen=True, slots=True)
class PurchaseLot:
    """구매 건 하나의 금액·수량과 그 규격의 용량."""

    quantity: int
    volume_ml: int
    unit_list_price: Decimal | None = None
    unit_paid_price: Decimal | None = None

    def __post_init__(self) -> None:
        if self.quantity <= 0:
            raise ValueError(f"구매 병수는 양수여야 합니다: {self.quantity}")
        if self.volume_ml <= 0:
            raise ValueError(f"용량은 양수여야 합니다: {self.volume_ml}")

    @property
    def list_total(self) -> Decimal | None:
        """정가 총액. 단가가 없으면 None."""
        if self.unit_list_price is None:
            return None
        return self.unit_list_price * Decimal(self.quantity)

    @property
    def paid_total(self) -> Decimal | None:
        """실지불 총액. 단가가 없으면 None."""
        if self.unit_paid_price is None:
            return None
        return self.unit_paid_price * Decimal(self.quantity)

    @property
    def total_volume_ml(self) -> int:
        return self.volume_ml * self.quantity


@dataclass(frozen=True, slots=True)
class BottleRecord:
    """병 하나의 상태와 날짜."""

    status: str
    opened_on: datetime.date | None = None
    finished_on: datetime.date | None = None

    @property
    def in_stock(self) -> bool:
        return self.status in IN_STOCK_STATES

    @property
    def days_to_finish(self) -> int | None:
        """개봉 후 소진까지 걸린 일수. 둘 중 하나라도 없으면 None."""
        if self.opened_on is None or self.finished_on is None:
            return None
        return (self.finished_on - self.opened_on).days


@dataclass(frozen=True, slots=True)
class BottleTally:
    """상태별 병수 집계."""

    unopened: int = 0
    open: int = 0
    finished: int = 0
    gifted: int = 0
    sold: int = 0

    @property
    def in_stock(self) -> int:
        """재고 병수. 증여·판매·소진은 재고가 아니다."""
        return self.unopened + self.open

    @property
    def disposed(self) -> int:
        return self.gifted + self.sold

    @property
    def total(self) -> int:
        return self.in_stock + self.finished + self.disposed


def tally_bottles(bottles: Iterable[BottleRecord]) -> BottleTally:
    """병 목록을 상태별로 집계한다. 알 수 없는 상태는 세지 않고 무시한다."""
    counts = dict.fromkeys(
        (
            BottleState.UNOPENED,
            BottleState.OPEN,
            BottleState.FINISHED,
            BottleState.GIFTED,
            BottleState.SOLD,
        ),
        0,
    )
    for bottle in bottles:
        if bottle.status in counts:
            counts[bottle.status] += 1
    return BottleTally(
        unopened=counts[BottleState.UNOPENED],
        open=counts[BottleState.OPEN],
        finished=counts[BottleState.FINISHED],
        gifted=counts[BottleState.GIFTED],
        sold=counts[BottleState.SOLD],
    )


@dataclass(frozen=True, slots=True)
class PriceMetrics:
    """금액 관련 파생 지표."""

    purchased_count: int
    priced_quantity: int
    paid_quantity: int
    list_total: Decimal | None
    paid_total: Decimal | None
    avg_list_price: Decimal | None
    avg_paid_price: Decimal | None
    price_per_100ml: Decimal | None
    price_per_100ml_paid: Decimal | None
    discount_rate: Decimal | None
    total_volume_ml: int

    @property
    def has_prices(self) -> bool:
        return self.avg_list_price is not None or self.avg_paid_price is not None


def _weighted_total(lots: Sequence[PurchaseLot], *, paid: bool) -> tuple[Decimal | None, int, int]:
    """가격이 있는 구매 건만 합산한다.

    반환값은 (금액 합계, 병수 합계, 용량 합계 ml). 금액이 있는 구매 건이 없으면 금액은
    None 이다. 0 을 반환하면 "전부 무료" 와 "가격 정보 없음" 을 구분할 수 없다.
    """
    amount = Decimal(0)
    quantity = 0
    volume = 0
    found = False
    for lot in lots:
        total = lot.paid_total if paid else lot.list_total
        if total is None:
            continue
        found = True
        amount += total
        quantity += lot.quantity
        volume += lot.total_volume_ml
    return (amount if found else None), quantity, volume


def compute_price_metrics(lots: Sequence[PurchaseLot]) -> PriceMetrics:
    """구매 건 목록에서 금액 파생 지표를 계산한다."""
    purchased = sum(lot.quantity for lot in lots)
    total_volume = sum(lot.total_volume_ml for lot in lots)

    list_total, list_quantity, list_volume = _weighted_total(lots, paid=False)
    paid_total, paid_quantity, paid_volume = _weighted_total(lots, paid=True)

    avg_list = (
        quantize_money(list_total / Decimal(list_quantity))
        if list_total is not None and list_quantity > 0
        else None
    )
    avg_paid = (
        quantize_money(paid_total / Decimal(paid_quantity))
        if paid_total is not None and paid_quantity > 0
        else None
    )

    # 여러 용량이 섞이면 가중 평균이어야 한다. 단일 용량이면 avg / (volume/100) 과 같다.
    per_100ml = (
        quantize_money(list_total * ML_PER_UNIT / Decimal(list_volume))
        if list_total is not None and list_volume > 0
        else None
    )
    per_100ml_paid = (
        quantize_money(paid_total * ML_PER_UNIT / Decimal(paid_volume))
        if paid_total is not None and paid_volume > 0
        else None
    )

    discount = _discount_rate(lots)

    return PriceMetrics(
        purchased_count=purchased,
        priced_quantity=list_quantity,
        paid_quantity=paid_quantity,
        list_total=list_total,
        paid_total=paid_total,
        avg_list_price=avg_list,
        avg_paid_price=avg_paid,
        price_per_100ml=per_100ml,
        price_per_100ml_paid=per_100ml_paid,
        discount_rate=discount,
        total_volume_ml=total_volume,
    )


def _discount_rate(lots: Sequence[PurchaseLot]) -> Decimal | None:
    """할인율. 정가와 실구매가가 **모두 있는** 구매 건만으로 계산한다.

    한쪽만 있는 구매 건을 섞으면 분모와 분자의 모집단이 달라져 할인율이 왜곡된다.
    """
    list_amount = Decimal(0)
    paid_amount = Decimal(0)
    found = False
    for lot in lots:
        if lot.unit_list_price is None or lot.unit_paid_price is None:
            continue
        found = True
        list_amount += lot.unit_list_price * Decimal(lot.quantity)
        paid_amount += lot.unit_paid_price * Decimal(lot.quantity)
    if not found or list_amount == 0:
        return None
    return quantize_ratio(Decimal(1) - paid_amount / list_amount)


@dataclass(frozen=True, slots=True)
class ProductMetrics:
    """제품 하나의 전체 파생 지표."""

    prices: PriceMetrics
    bottles: BottleTally
    inventory_value_at_cost: Decimal | None
    average_days_to_finish: Decimal | None
    consistency_warnings: tuple[str, ...] = field(default=())

    @property
    def in_stock_count(self) -> int:
        return self.bottles.in_stock

    @property
    def consumed_count(self) -> int:
        return self.bottles.finished


def compute_product_metrics(
    lots: Sequence[PurchaseLot], bottles: Sequence[BottleRecord]
) -> ProductMetrics:
    """제품 수준 파생 지표를 계산한다.

    병수 정합성이 어긋나면 예외 대신 경고를 남긴다. 레거시에서 넘어온 데이터가
    완벽하지 않을 수 있고, 지표를 아예 못 보는 것보다 경고와 함께 보는 것이 낫다.
    """
    prices = compute_price_metrics(lots)
    tally = tally_bottles(bottles)

    warnings: list[str] = []
    if tally.total != prices.purchased_count:
        warnings.append(
            f"병 레코드 수({tally.total})가 구매 병수({prices.purchased_count})와 다릅니다"
        )

    inventory_value = (
        quantize_money(prices.avg_paid_price * Decimal(tally.in_stock))
        if prices.avg_paid_price is not None
        else None
    )

    durations = [bottle.days_to_finish for bottle in bottles if bottle.days_to_finish is not None]
    average_days = (
        quantize_ratio(Decimal(sum(durations)) / Decimal(len(durations))) if durations else None
    )

    return ProductMetrics(
        prices=prices,
        bottles=tally,
        inventory_value_at_cost=inventory_value,
        average_days_to_finish=average_days,
        consistency_warnings=tuple(warnings),
    )


def value_for_money(rating: Decimal | None, price_per_100ml: Decimal | None) -> Decimal | None:
    """가성비. 100ml당 가격 1,000원 기준으로 정규화해 값이 너무 작아지지 않게 한다.

    높을수록 좋다. 가격이 0이면 정의되지 않는다.
    """
    if rating is None or price_per_100ml is None or price_per_100ml <= 0:
        return None
    return quantize_ratio(rating * Decimal(1000) / price_per_100ml)


def consumption_rate_per_month(finished_count: int, days: int) -> Decimal | None:
    """소비 속도(월 환산 병수). 기간이 0이면 정의되지 않는다."""
    if days <= 0:
        return None
    return quantize_ratio(Decimal(finished_count) * Decimal(30) / Decimal(days))


def krw_from_foreign(foreign_amount: Decimal | None, fx_rate: Decimal | None) -> Decimal | None:
    """외화 금액을 구매 시점 환율로 원화 환산한다.

    환율은 구매 시점 값으로 고정한다. 현재 환율로 재평가하면 과거 지출액이 매일 바뀌어
    통계가 재현되지 않는다(`docs/architecture.md` §2.3 `purchase`).
    """
    if foreign_amount is None or fx_rate is None:
        return None
    return quantize_money(foreign_amount * fx_rate)
