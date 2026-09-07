"""규격·통화·판매 조건·신선도·수량/재고와 재알림 경계를 검증한다."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from sooljang.domain.price_watch import (
    WatchCriteria,
    WatchObservation,
    evaluate_price,
    scheduled_slot,
    should_notify,
)

NOW = datetime(2026, 9, 7, 12, tzinfo=UTC)
CONDITIONS = {
    "price_kind": "regular",
    "membership": "none",
    "coupon": "none",
    "fulfillment": "pickup",
    "region": "서울",
    "shipping": "none",
    "tax": "included",
}
CRITERIA = WatchCriteria(
    "product-one", "seller-one", "condition-one", "KRW", Decimal(700), 1, Decimal(50000), CONDITIONS
)
FACTS = {
    **CONDITIONS,
    "product_key": "product-one",
    "offer_key": "seller-one",
    "condition_key": "condition-one",
    "volume_ml": 700,
    "units": 1,
    "is_set": False,
    "in_stock": True,
}
OBSERVATION = WatchObservation(Decimal(49000), "KRW", NOW, FACTS, True, True, True)


def test_same_known_conditions_at_target_are_eligible_and_satisfied() -> None:
    decision = evaluate_price(CRITERIA, OBSERVATION, NOW)
    assert decision.eligible and decision.satisfies
    assert evaluate_price(CRITERIA, replace(OBSERVATION, amount=Decimal(50000)), NOW).satisfies
    assert not evaluate_price(CRITERIA, replace(OBSERVATION, amount=Decimal(50001)), NOW).satisfies
    assert evaluate_price(CRITERIA, replace(OBSERVATION, amount=Decimal(0)), NOW).satisfies


@pytest.mark.parametrize(
    "changes",
    [
        {"fresh": False},
        {"complete": False},
        {"confirmed": False},
        {"currency": "USD"},
        {"fetched_at": NOW - timedelta(hours=2)},
        {"fetched_at": NOW + timedelta(seconds=1)},
        {"amount": Decimal("NaN")},
    ],
)
def test_cached_partial_unconfirmed_or_stale_observations_never_alert(changes: dict) -> None:
    decision = evaluate_price(CRITERIA, replace(OBSERVATION, **changes), NOW)
    assert not decision.eligible and not decision.satisfies


@pytest.mark.parametrize(
    "changes",
    [
        {"in_stock": False},
        {"in_stock": None},
        {"volume_ml": 750},
        {"volume_ml": None},
        {"units": 2},
        {"units": True},
        {"is_set": True},
        {"coupon": "required"},
        {"membership": None},
        {"region": "부산"},
        {"currency": "USD", "condition_key": "other"},
        {"product_key": "other"},
        {"offer_key": "other"},
    ],
)
def test_unknown_stock_different_sku_coupon_or_region_never_alerts(changes: dict) -> None:
    decision = evaluate_price(CRITERIA, replace(OBSERVATION, facts={**FACTS, **changes}), NOW)
    assert not decision.eligible and not decision.satisfies


def test_same_price_does_not_repeat_but_lower_price_or_reentry_can_after_cooldown() -> None:
    decision = evaluate_price(CRITERIA, OBSERVATION, NOW)
    args: dict[str, Any] = {
        "decision": decision,
        "amount": Decimal(49000),
        "last_amount": Decimal(49000),
        "last_satisfied": True,
        "last_notified_at": NOW - timedelta(days=2),
        "now": NOW,
        "cooldown_seconds": 86400,
    }

    def check(**changes: Any) -> bool:
        values: dict[str, Any] = dict(args)
        values.update(changes)
        return should_notify(**values)

    assert not check()
    assert check(amount=Decimal(48000))
    assert check(last_satisfied=False)
    assert not check(amount=Decimal(48000), last_notified_at=NOW - timedelta(hours=1))


def test_utc_slot_does_not_expand_missed_intervals_or_depend_on_local_timezone() -> None:
    assert scheduled_slot(NOW, 3600) == scheduled_slot(NOW + timedelta(minutes=59), 3600)
    assert scheduled_slot(NOW + timedelta(days=30), 3600) == NOW + timedelta(days=30)
    assert scheduled_slot(NOW.astimezone(), 3600) == NOW


@pytest.mark.parametrize(
    "changes",
    [
        {"volume_ml": Decimal(0)},
        {"currency": "krw"},
        {"target_amount": Decimal(-1)},
        {"max_age_seconds": 0},
        {"conditions": {}},
        {"conditions": {**CONDITIONS, "price_kind": "snippet"}},
    ],
)
def test_invalid_watch_criteria_are_rejected(changes: dict) -> None:
    with pytest.raises(ValueError):
        replace(CRITERIA, **changes)
