"""출처/판매 조건과 실제 구매를 혼동하지 않는 최소 계약."""

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from sooljang.domain.discovery import OfferIdentity, PriceObservation


def offer(**changes: object) -> OfferIdentity:
    original = OfferIdentity("source-a", "product-a", "store-a", "bottling-2024", Decimal(700))
    return replace(original, **changes)


def test_different_sellers_can_only_compare_same_variant_volume_and_conditions() -> None:
    original = offer()
    assert original.comparable_to(offer(source_key="source-b", seller_key="store-b"))
    assert original != offer(seller_key="store-b")
    for changed in (
        offer(variant_key="bottling-2025"),
        offer(volume_ml=Decimal(750)),
        offer(units=2),
        offer(condition_key="membership"),
        offer(volume_ml=None),
    ):
        assert not original.comparable_to(changed)
    assert not offer(volume_ml=None).comparable_to(offer(volume_ml=None))


def test_missing_price_and_free_price_remain_distinct_observations() -> None:
    missing = PriceObservation(
        offer(), None, "KRW", "https://example.com/item/1", datetime.now(UTC)
    )
    free = replace(missing, amount=Decimal(0))
    assert missing.amount is None
    assert free.amount == 0
    assert missing != free
    assert replace(missing, complete=True).observed_at == missing.observed_at


@pytest.mark.parametrize("value", [Decimal(-1), Decimal("NaN"), Decimal("Infinity")])
def test_invalid_observed_prices_are_rejected(value: Decimal) -> None:
    with pytest.raises(ValueError):
        PriceObservation(offer(), value, "KRW", "https://example.com/item/1", datetime.now(UTC))


def test_observation_requires_timezone_source_and_currency() -> None:
    valid = PriceObservation(
        offer(), Decimal(100), "KRW", "https://example.com/item/1", datetime.now(UTC)
    )
    for changes in (
        {"source_url": "javascript:alert(1)"},
        {"currency": "krw"},
        {"currency": "123"},
        {"observed_at": datetime(2026, 9, 7)},
    ):
        with pytest.raises(ValueError):
            replace(valid, **changes)


@pytest.mark.parametrize(
    "changes",
    [{"source_key": ""}, {"units": 0}, {"volume_ml": Decimal(0)}, {"volume_ml": Decimal("NaN")}],
)
def test_offer_requires_stable_identity_and_valid_unit(changes: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        offer(**changes)
