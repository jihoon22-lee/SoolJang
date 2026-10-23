"""표준 필드 스키마 표 기반 테스트(Task 34 PR3). 네트워크 불필요."""

import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

from sooljang.infrastructure.external.adapter import AdapterResult
from sooljang.infrastructure.external.fields import NormalizedFields, split_fields


def test_standard_keys_are_typed_from_strings() -> None:
    normalized = split_fields({"price_krw": "89,000원", "volume_ml": "700ml", "rating": "4.3"})
    assert normalized.price_krw == 89000
    assert normalized.volume_ml == 700
    assert normalized.rating == 4.3
    assert normalized.extra == {}


def test_non_standard_keys_go_to_extra() -> None:
    """기존 소스가 표준 키로 안 바뀌어도 값이 사라지면 안 된다."""
    normalized = split_fields({"가격": "89000", "평점": "4.3", "price_krw": 89000})
    assert normalized.price_krw == 89000
    assert normalized.extra == {"가격": "89000", "평점": "4.3"}


def test_rating_normalized_scales_to_five() -> None:
    normalized = split_fields({"rating": 87, "rating_scale": 100})
    assert normalized.rating_normalized == Decimal("4.35")


def test_rating_normalized_none_without_scale() -> None:
    normalized = split_fields({"rating": 4.3})
    assert normalized.rating_normalized is None


def test_price_per_100ml_none_without_volume() -> None:
    """0 나눗셈 방지 — 용량이 없으면 계산하지 않는다."""
    normalized = split_fields({"price_krw": 89000})
    assert normalized.price_per_100ml is None


def test_price_per_100ml_computed() -> None:
    normalized = split_fields({"price_krw": 89000, "volume_ml": 700})
    assert normalized.price_per_100ml == Decimal("12714.29")


def test_currency_defaults_to_krw() -> None:
    normalized = split_fields({"price_krw": 1000})
    assert normalized.currency == "KRW"


def test_currency_overridden() -> None:
    normalized = split_fields({"price_krw": 1000, "currency": "USD"})
    assert normalized.currency == "USD"


def test_in_stock_coerced_from_korean_tokens() -> None:
    assert split_fields({"in_stock": "품절"}).in_stock is False
    assert split_fields({"in_stock": "있음"}).in_stock is True


def test_bool_value_not_miscoerced_as_int() -> None:
    """bool 은 int 의 서브클래스다 — `price_krw` 자리에 True 가 오면 정수로 새면 안 된다."""
    normalized = split_fields({"price_krw": True})
    assert normalized.price_krw is None
    assert normalized.extra == {"price_krw": True}


def test_invalid_type_falls_back_to_extra() -> None:
    normalized = split_fields({"volume_ml": "n/a"})
    assert normalized.volume_ml is None
    assert normalized.extra == {"volume_ml": "n/a"}


def test_none_values_are_dropped_entirely() -> None:
    normalized = split_fields({"price_krw": None, "가격": None})
    assert normalized.price_krw is None
    assert normalized.extra == {}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({}, NormalizedFields()),
        ({"price_krw": 0}, NormalizedFields(price_krw=0)),
    ],
)
def test_edge_cases(raw: dict[str, object], expected: NormalizedFields) -> None:
    assert split_fields(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        {"price_krw": float("inf"), "volume_ml": float("nan"), "rating": 10**400},
        {"price_krw": "9" * 400, "volume_ml": "9" * 400, "rating": "9" * 400},
        # JSON 정수는 inf 가 되지 않고 int 로 들어온다. 유한한 1e300 도 반올림하면 거대한 정수다.
        {"price_krw": 10**400, "volume_ml": 10**30, "rating": None},
        {"price_krw": 1e300, "volume_ml": "9" * 300, "rating": None},
    ],
)
def test_non_finite_or_huge_numbers_become_missing_instead_of_raising(
    raw: dict[str, object],
) -> None:
    normalized = split_fields(raw)

    assert normalized.price_krw is None
    assert normalized.volume_ml is None
    assert normalized.rating is None
    assert normalized.price_per_100ml is None


def test_non_finite_values_are_dropped_everywhere_instead_of_kept_in_extra() -> None:
    raw = {
        "price_krw": float("inf"),
        "tasting": {"score": float("nan"), "note": "합성"},
        "history": [1.5, float("-inf")],
    }

    normalized = split_fields(raw)

    assert normalized.price_krw is None
    assert normalized.extra == {"tasting": {"note": "합성"}, "history": [1.5]}
    json.dumps(normalized.extra, allow_nan=False)


def test_adapter_result_strips_non_finite_values_before_response_and_cache() -> None:
    result = AdapterResult(
        source_url="https://example.com/p",
        fields={"price_krw": float("inf"), "volume_ml": 700, "nested": [float("nan")]},
        raw_excerpt=None,
        degraded=False,
        warning=None,
        offers=[{"amount": "1000", "facts": {"rating": float("inf")}}],
    )

    assert result.fields == {"volume_ml": 700, "nested": []}
    json.dumps({"fields": result.fields, "offers": result.offers}, allow_nan=False)


def test_large_but_plausible_price_still_computes_per_100ml() -> None:
    normalized = split_fields({"price_krw": 10**12, "volume_ml": 750})

    assert normalized.price_per_100ml == Decimal("133333333333.33")


@pytest.mark.parametrize(
    "rating,scale",
    [
        (1e300, 5),
        (4, 1e-300),
        (-1, 5),
        (6, 5),
        (4, 0),
        (4, -5),
        (float("nan"), 5),
        (float("inf"), 5),
        (4, float("inf")),
        (4, float("nan")),
    ],
)
def test_invalid_source_rating_has_no_normalized_value(rating: float, scale: float) -> None:
    # 직접 만든 값과 이전 캐시의 fields를 다시 분류한 값 모두 같은 규칙을 지킨다.
    direct = NormalizedFields(rating=rating, rating_scale=scale)
    assert direct.rating_normalized is None
    normalized = split_fields({"rating": rating, "rating_scale": scale})
    assert normalized.rating_normalized is None


@pytest.mark.parametrize(
    "rating,scale,expected",
    [(0, 5, "0.00"), (87, 100, "4.35"), (5, 5, "5.00"), (1e300, 1e300, "5.00")],
)
def test_valid_source_rating_keeps_zero_and_original_scale(
    rating: float, scale: float, expected: str
) -> None:
    normalized = split_fields({"rating": rating, "rating_scale": scale})
    assert normalized.rating == rating
    assert normalized.rating_scale == scale
    assert normalized.rating_normalized == Decimal(expected)


@pytest.mark.parametrize("rating", [True, False])
def test_boolean_is_not_a_rating_even_when_constructed_directly(rating: bool) -> None:
    assert NormalizedFields(rating=rating, rating_scale=5).rating_normalized is None


@pytest.mark.parametrize("cached", [True, False])
async def test_discovery_serializes_valid_sources_beside_an_invalid_rating(cached: bool) -> None:
    from sqlalchemy.ext.asyncio import AsyncSession

    from sooljang.api.routes.discovery import _outputs
    from sooljang.application.external_sources import SourceLookupResult

    results = []
    for name, rating, scale in [("깨진 척도", 1e300, 5), ("정상 척도", 87, 100)]:
        fields = {"rating": rating, "rating_scale": scale}
        results.append(
            SourceLookupResult(
                source_id=uuid.uuid4(),
                source_name=name,
                cached=cached,
                source_url="https://example.com/product",
                fields=fields,
                raw_excerpt=None,
                degraded=False,
                warning=None,
                fetched_at=datetime.now(UTC),
                normalized=split_fields(fields),
            )
        )
    outputs = await _outputs(results, AsyncMock(spec=AsyncSession), uuid.uuid4(), "")
    assert len(outputs) == 2
    assert outputs[0]["normalized"]["rating_normalized"] is None
    assert outputs[0]["fields"] == {"rating": 1e300, "rating_scale": 5}
    assert outputs[1]["normalized"]["rating_normalized"] == "4.35"
    assert all(row["cached"] is cached for row in outputs)
    json.dumps(outputs, allow_nan=False)
