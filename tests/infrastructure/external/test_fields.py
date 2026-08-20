"""표준 필드 스키마 테스트(Task 34 PR3).

사이트는 가격을 `"89,000원"` 처럼 문자열로 준다 — 숫자로 바꿔 두지 않으면 최저가 비교가
문자열 비교가 돼 버린다. 여기서 그 변환과 `extra` 폴백을 검증한다.
"""

import pytest

from sooljang.infrastructure.external.fields import (
    coerce,
    price_per_100ml,
    rating_normalized,
    split_fields,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("89,000원", 89000),
        ("₩89000", 89000),
        ("89000", 89000),
        (89000, 89000),
        (89000.4, 89000),
        ("", None),
        ("품절", None),
        (None, None),
    ],
)
def test_가격_문자열을_정수로_바꾼다(raw: object, expected: int | None) -> None:
    assert coerce("price_krw", raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("4.5", 4.5), (4.5, 4.5), ("4.5점", 4.5), ("없음", None)],
)
def test_평점은_실수로_바꾼다(raw: object, expected: float | None) -> None:
    assert coerce("rating", raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(True, True), ("재고있음", True), ("품절", False), ("false", False), ("몰라", None)],
)
def test_재고_표기를_불리언으로_바꾼다(raw: object, expected: bool | None) -> None:
    assert coerce("in_stock", raw) is expected


def test_표준_키가_아니면_extra로_보존한다() -> None:
    """데일리샷의 한글 키(`가격`·`평점`·`리뷰수`)가 실제 사례다 — 값이 사라지면 안 된다."""
    standard, extra = split_fields(
        {"price_krw": "89,000원", "가격": "89,000원", "평점": "4.9", "리뷰수": 738}
    )

    assert standard == {"price_krw": 89000}
    assert extra == {"가격": "89,000원", "평점": "4.9", "리뷰수": 738}


def test_표준_키가_하나도_없어도_값을_잃지_않는다() -> None:
    standard, extra = split_fields({"가격": 89000, "평점": 4.9})

    assert standard == {}
    assert extra == {"가격": 89000, "평점": 4.9}


@pytest.mark.parametrize(
    ("rating", "scale", "expected"),
    [
        (4.3, 5, 4.3),
        (87, 100, 4.35),
        (4.9, 5, 4.9),
        (4.3, None, None),
        (None, 5, None),
        (4.3, 0, None),
    ],
)
def test_평점을_5점_척도로_환산한다(rating: object, scale: object, expected: float | None) -> None:
    assert rating_normalized(rating, scale) == expected


@pytest.mark.parametrize(
    ("price", "volume", "expected"),
    [
        (89000, 700, 12714.29),
        (45000, 375, 12000.0),
        (89000, None, None),
        (89000, 0, None),
        (None, 700, None),
    ],
)
def test_100ml당_가격을_계산한다(price: object, volume: object, expected: float | None) -> None:
    assert price_per_100ml(price, volume) == expected
