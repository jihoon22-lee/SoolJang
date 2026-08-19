"""표준 필드 스키마 표 기반 테스트(Task 34 PR3). 네트워크 불필요."""

from decimal import Decimal

import pytest

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
