"""가격 감시의 순수 판정. 조건이 확인되지 않은 가격은 목표 충족으로 추정하지 않는다."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

CONDITION_FIELDS = (
    "price_kind",
    "membership",
    "coupon",
    "fulfillment",
    "region",
    "shipping",
    "tax",
)


@dataclass(frozen=True, slots=True)
class WatchCriteria:
    product_key: str
    offer_key: str
    condition_key: str
    currency: str
    volume_ml: Decimal
    units: int
    target_amount: Decimal
    conditions: dict[str, Any]
    max_age_seconds: int = 3600

    def __post_init__(self) -> None:
        if not all((self.product_key, self.offer_key, self.condition_key)):
            raise ValueError("제품·판매자·판매 조건을 선택하세요")
        if (
            len(self.currency) != 3
            or not self.currency.isascii()
            or not self.currency.isalpha()
            or not self.currency.isupper()
        ):
            raise ValueError("통화는 3자리 대문자 코드여야 합니다")
        if not self.volume_ml.is_finite() or self.volume_ml <= 0 or self.units < 1:
            raise ValueError("용량과 판매 수량을 확인하세요")
        if not self.target_amount.is_finite() or self.target_amount < 0:
            raise ValueError("목표가는 유한한 0 이상의 금액이어야 합니다")
        if not 60 <= self.max_age_seconds <= 86400:
            raise ValueError("가격 유효 시간은 1분 이상 24시간 이하입니다")
        if any(self.conditions.get(key) is None for key in CONDITION_FIELDS):
            raise ValueError("회원·쿠폰·배송·세금·지역 등 판매 조건을 먼저 확인하세요")
        if self.conditions["price_kind"] in {"snippet", "recommended"}:
            raise ValueError("검색 발췌·권장 가격은 감시할 수 없습니다")


@dataclass(frozen=True, slots=True)
class WatchObservation:
    amount: Decimal
    currency: str
    fetched_at: datetime
    facts: dict[str, Any]
    fresh: bool
    complete: bool
    confirmed: bool


@dataclass(frozen=True, slots=True)
class PriceDecision:
    eligible: bool
    satisfies: bool
    reason: str


def evaluate_price(
    criteria: WatchCriteria, observation: WatchObservation, now: datetime
) -> PriceDecision:
    if now.tzinfo is None or observation.fetched_at.tzinfo is None:
        raise ValueError("판정 시각에는 시간대가 필요합니다")
    if not observation.fresh:
        return PriceDecision(False, False, "cached")
    if not observation.complete or not observation.confirmed:
        return PriceDecision(False, False, "unconfirmed")
    age = now - observation.fetched_at
    if age < timedelta(0) or age > timedelta(seconds=criteria.max_age_seconds):
        return PriceDecision(False, False, "stale")
    facts = observation.facts
    source_time = facts.get("source_observed_at")
    if source_time is not None:
        try:
            observed = datetime.fromisoformat(source_time)
            if observed.tzinfo is None or not timedelta(0) <= now - observed <= timedelta(
                seconds=criteria.max_age_seconds
            ):
                return PriceDecision(False, False, "stale")
        except ValueError, TypeError:
            return PriceDecision(False, False, "stale")
    if facts.get("in_stock") is not True:
        return PriceDecision(False, False, "stock_unconfirmed")
    try:
        volume = Decimal(str(facts.get("volume_ml")))
    except InvalidOperation, ValueError:
        return PriceDecision(False, False, "different_sku")
    if (
        not volume.is_finite()
        or volume != criteria.volume_ml
        or facts.get("units") != criteria.units
        or not isinstance(facts.get("units"), int)
        or isinstance(facts.get("units"), bool)
        or facts.get("is_set") is not False
    ):
        return PriceDecision(False, False, "different_sku")
    if observation.currency != criteria.currency:
        return PriceDecision(False, False, "different_currency")
    if any(
        facts.get(key) != expected
        for key, expected in (
            ("product_key", criteria.product_key),
            ("offer_key", criteria.offer_key),
            ("condition_key", criteria.condition_key),
        )
    ):
        return PriceDecision(False, False, "different_offer")
    if any(
        type(facts.get(key)) is not type(criteria.conditions[key])
        or facts.get(key) != criteria.conditions[key]
        for key in CONDITION_FIELDS
    ):
        return PriceDecision(False, False, "different_conditions")
    if not observation.amount.is_finite() or observation.amount < 0:
        return PriceDecision(False, False, "invalid_price")
    return PriceDecision(
        True,
        observation.amount <= criteria.target_amount,
        "satisfied" if observation.amount <= criteria.target_amount else "above_target",
    )


def should_notify(
    *,
    decision: PriceDecision,
    amount: Decimal,
    last_amount: Decimal | None,
    last_satisfied: bool,
    last_notified_at: datetime | None,
    now: datetime,
    cooldown_seconds: int,
) -> bool:
    """동일 가격 반복 알림 없음. 목표 미충족 뒤 재진입 또는 추가 하락에만 cooldown 후 알린다."""
    return (
        decision.eligible
        and decision.satisfies
        and (
            last_notified_at is None
            or now - last_notified_at >= timedelta(seconds=cooldown_seconds)
        )
        and (last_amount is None or not last_satisfied or amount < last_amount)
    )


def scheduled_slot(now: datetime, interval_seconds: int) -> datetime:
    """UTC 간격 한 건으로 합친다. 재시작 시 과거 누락 일정을 순회하지 않는다."""
    if now.tzinfo is None or not 900 <= interval_seconds <= 604800:
        raise ValueError("시간대와 15분~7일 조회 간격이 필요합니다")
    timestamp = int(now.timestamp())
    return datetime.fromtimestamp(timestamp - timestamp % interval_seconds, tz=UTC)
