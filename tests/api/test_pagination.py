"""커서 페이지네이션 단위 테스트.

정렬키에 NULL 이 섞일 때가 가장 위험하다. NULL 비교는 항상 거짓이 되어 나머지 페이지가
조용히 사라진다. 도수·평점처럼 결측이 흔한 필드로 정렬할 때 실제로 발생한다.
"""

import datetime
import uuid
from decimal import Decimal

import pytest

from sooljang.api.errors import ValidationFailedError
from sooljang.api.pagination import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    Cursor,
    Page,
    build_page,
    normalize_limit,
)

_ID = uuid.UUID("019fb8b2-0000-7000-8000-000000000001")


def test_cursor_round_trip_preserves_string_value() -> None:
    cursor = Cursor(sort_value="글렌알라키", id=_ID)

    restored = Cursor.decode(cursor.encode())

    assert restored.sort_value == "글렌알라키"
    assert restored.id == _ID


def test_cursor_round_trip_preserves_decimal_precision() -> None:
    """금액·도수를 float 로 왕복하면 정밀도를 잃어 커서가 어긋난다."""
    cursor = Cursor(sort_value=Decimal("3197.33"), id=_ID)

    restored = Cursor.decode(cursor.encode())

    assert restored.sort_value == Decimal("3197.33")
    assert isinstance(restored.sort_value, Decimal)


def test_cursor_round_trip_preserves_none() -> None:
    cursor = Cursor(sort_value=None, id=_ID)

    assert Cursor.decode(cursor.encode()).sort_value is None


def test_cursor_encodes_datetime_as_iso() -> None:
    moment = datetime.datetime(2026, 8, 1, 12, 30, tzinfo=datetime.UTC)

    restored = Cursor.decode(Cursor(sort_value=moment, id=_ID).encode())

    assert restored.sort_value == moment.isoformat()


def test_cursor_is_url_safe_without_padding() -> None:
    encoded = Cursor(sort_value="가나다라마바사아자차카타파하", id=_ID).encode()

    assert "=" not in encoded
    assert "+" not in encoded
    assert "/" not in encoded


@pytest.mark.parametrize("raw", ["", "!!!", "not-base64", "YWJj"])
def test_invalid_cursor_raises_validation_error(raw: str) -> None:
    with pytest.raises(ValidationFailedError, match="cursor"):
        Cursor.decode(raw)


@pytest.mark.parametrize(
    ("given", "expected"),
    [(None, DEFAULT_LIMIT), (1, 1), (50, 50), (MAX_LIMIT, MAX_LIMIT), (MAX_LIMIT + 1, MAX_LIMIT)],
)
def test_normalize_limit(given: int | None, expected: int) -> None:
    assert normalize_limit(given) == expected


@pytest.mark.parametrize("given", [0, -1])
def test_normalize_limit_rejects_non_positive(given: int) -> None:
    with pytest.raises(ValidationFailedError, match="limit"):
        normalize_limit(given)


class _Row:
    def __init__(self, name: str, row_id: uuid.UUID) -> None:
        self.name = name
        self.id = row_id


def test_build_page_without_extra_row_has_no_cursor() -> None:
    rows = [_Row("가", uuid.uuid4()), _Row("나", uuid.uuid4())]

    page = build_page(rows, limit=3, sort_value_of=lambda r: r.name, id_of=lambda r: r.id)

    assert page.next_cursor is None
    assert page.has_more is False
    assert len(page.items) == 2


def test_build_page_with_extra_row_trims_and_creates_cursor() -> None:
    """`limit + 1` 개를 읽어 다음 페이지 존재를 판단한다. COUNT 쿼리가 필요 없다."""
    rows = [_Row(name, uuid.uuid4()) for name in ("가", "나", "다")]

    page = build_page(rows, limit=2, sort_value_of=lambda r: r.name, id_of=lambda r: r.id)

    assert len(page.items) == 2
    assert page.has_more is True
    assert page.next_cursor is not None
    restored = Cursor.decode(page.next_cursor)
    # 커서는 보이는 마지막 항목을 가리켜야 한다. 잘라낸 항목을 가리키면 한 건이 누락된다.
    assert restored.sort_value == "나"
    assert restored.id == rows[1].id


def test_page_generic_holds_items() -> None:
    page: Page[str] = Page(items=["가"], next_cursor=None)

    assert page.items == ["가"]
    assert page.has_more is False
