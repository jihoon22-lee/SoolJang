"""필드 정규화 단위 테스트 (`docs/legacy-schema.md` §4)."""

from decimal import Decimal

import pytest

from sooljang.infrastructure.legacy.normalize import (
    extract_vintage,
    is_empty_token,
    normalize_name_for_matching,
    parse_abv,
    parse_external_ratings,
    parse_foreign_price,
    parse_int,
    parse_money,
    parse_rating,
    parse_volume_ml,
    split_multivalue,
    split_name_and_note,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (" \\23,980 ", Decimal(23980)),
        (" \\1,303,064 ", Decimal(1303064)),
        ("₩45,000", Decimal(45000)),
        ("45000", Decimal(45000)),
        (" \\- ", None),
        ("", None),
        (None, None),
        ("#N/A", None),
        ("알 수 없음", None),
    ],
)
def test_parse_money_handles_cp949_won_sign_and_empty_tokens(
    raw: str | None, expected: Decimal | None
) -> None:
    # CP949 에서 원화 기호는 백슬래시(0x5C)와 같은 코드포인트다.
    assert parse_money(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("750ml", 750),
        ("500ml", 500),
        ("1000ml", 1000),
        ("1L", 1000),
        ("1.5L", 1500),
        ("50ml", 50),
        ("", None),
        (None, None),
        ("0ml", None),
    ],
)
def test_parse_volume_ml(raw: str | None, expected: int | None) -> None:
    assert parse_volume_ml(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("14.5%", Decimal("14.5")),
        ("60.1%", Decimal("60.1")),
        ("40", Decimal(40)),
        ("", None),
        ("#N/A", None),
        (" \\848,000 ", None),  # 도수 칸에 금액이 들어온 통계 블록 행
        ("라벨", None),
    ],
)
def test_parse_abv_rejects_out_of_range_values(raw: str, expected: Decimal | None) -> None:
    assert parse_abv(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("3", 3), ("1,078", 1078), ("", None), ("#N/A", None), ("3.5", None)],
)
def test_parse_int(raw: str, expected: int | None) -> None:
    assert parse_int(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("6.0", Decimal("6.0")),
        ("0.5", Decimal("0.5")),
        ("3.5", Decimal("3.5")),
        ("", None),
        ("6.5", None),  # 레거시는 6점 만점이다
        ("0", None),
    ],
)
def test_parse_rating_enforces_six_point_scale(raw: str, expected: Decimal | None) -> None:
    assert parse_rating(raw) == expected


def test_split_multivalue_splits_on_newlines() -> None:
    assert split_multivalue("가상마트\n가상온라인샵\n") == ["가상마트", "가상온라인샵"]
    assert split_multivalue("") == []
    assert split_multivalue(None) == []


def test_split_name_and_note_keeps_first_line_as_name() -> None:
    name, note = split_name_and_note("가상 탁주\n25/04/10 발효")

    assert name == "가상 탁주"
    assert note == "25/04/10 발효"


def test_split_name_and_note_without_extra_lines() -> None:
    assert split_name_and_note("단일 이름") == ("단일 이름", None)
    assert split_name_and_note("") == ("", None)


@pytest.mark.parametrize(
    ("raw", "expected_name", "expected_vintage"),
    [
        ("가상 와이너리 카베르네, 2019", "가상 와이너리 카베르네", 2019),
        ("Pannon Tokaji Eszencia, 2008", "Pannon Tokaji Eszencia", 2008),
        ("부나하벤 21y 캐스크 스트렝스 2025", "부나하벤 21y 캐스크 스트렝스 2025", None),
        ("Gnarly Head 1924 Double Black", "Gnarly Head 1924 Double Black", None),
        ("숫자 없는 이름", "숫자 없는 이름", None),
    ],
)
def test_extract_vintage_only_splits_trailing_year(
    raw: str, expected_name: str, expected_vintage: int | None
) -> None:
    # 이름 안의 숫자(1924)를 빈티지로 오인해서는 안 된다.
    assert extract_vintage(raw) == (expected_name, expected_vintage)


def test_parse_external_ratings_splits_by_source_tag() -> None:
    ratings = parse_external_ratings("3.40 (RB)\n4.06/91 (BA)\n3.578 (U)")

    assert [(r.value, r.source_code, r.secondary_value) for r in ratings] == [
        (Decimal("3.40"), "RB", None),
        (Decimal("4.06"), "BA", Decimal(91)),
        (Decimal("3.578"), "U", None),
    ]


def test_parse_external_ratings_accepts_untagged_value() -> None:
    ratings = parse_external_ratings("3.9")

    assert len(ratings) == 1
    assert ratings[0].source_code is None
    assert ratings[0].value == Decimal("3.9")


def test_parse_external_ratings_ignores_unparseable_parts() -> None:
    assert parse_external_ratings("설명 텍스트") == []
    assert parse_external_ratings("") == []
    assert parse_external_ratings(None) == []


@pytest.mark.parametrize(
    ("note", "currency", "amount", "rate"),
    [
        ("$46.67 (환율 1431.6원)", "USD", Decimal("46.67"), Decimal("1431.6")),
        ("$127(환율 1443원)", "USD", Decimal(127), Decimal(1443)),
        ("$219.15 (환율 1469.5원)", "USD", Decimal("219.15"), Decimal("1469.5")),
        ("€35 (환율 1600원)", "EUR", Decimal(35), Decimal(1600)),
        ("$1,250", "USD", Decimal(1250), None),
    ],
)
def test_parse_foreign_price(
    note: str, currency: str, amount: Decimal, rate: Decimal | None
) -> None:
    parsed = parse_foreign_price(note)

    assert parsed is not None
    assert (parsed.currency, parsed.amount, parsed.fx_rate) == (currency, amount, rate)


@pytest.mark.parametrize("note", ["1+1", "수원페이 10%", "", None])
def test_parse_foreign_price_returns_none_without_currency(note: str | None) -> None:
    assert parse_foreign_price(note) is None


def test_normalize_name_for_matching_collapses_case_and_punctuation() -> None:
    assert normalize_name_for_matching("  Glen  Goyne 25Y!  ") == "glen goyne 25y"
    assert normalize_name_for_matching("가상 와이너리 - 카베르네") == "가상 와이너리 카베르네"


def test_is_empty_token_covers_excel_formula_errors() -> None:
    assert is_empty_token("#N/A")
    assert is_empty_token("#DIV/0!")
    assert is_empty_token(" - ")
    assert not is_empty_token("0")
