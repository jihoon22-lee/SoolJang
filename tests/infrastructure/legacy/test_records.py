"""행→레코드 변환 테스트."""

from decimal import Decimal
from pathlib import Path

import pytest

from sooljang.infrastructure.legacy.blocks import MAIN_HEADER
from sooljang.infrastructure.legacy.records import ParseReport, parse_rows, parse_sheet

FIXTURE = Path(__file__).parent / "testdata" / "sample_sheet.csv"


@pytest.fixture(scope="module")
def report() -> ParseReport:
    return parse_sheet(FIXTURE)


def _row(**overrides: str) -> list[str]:
    row = [""] * 20
    row[0] = overrides.get("name", "테스트 술")
    row[1] = overrides.get("volume", "700ml")
    row[2] = overrides.get("abv", "40.0%")
    row[3] = overrides.get("category", "싱글몰트 위스키")
    row[4] = overrides.get("variety", "")
    row[5] = overrides.get("list_total", "")
    row[6] = overrides.get("paid_total", "")
    row[10] = overrides.get("purchased", "1")
    row[11] = overrides.get("consumed", "0")
    row[12] = overrides.get("in_stock", "1")
    row[13] = overrides.get("unopened", "1")
    row[14] = overrides.get("opened", "0")
    row[15] = overrides.get("vendor", "")
    row[16] = overrides.get("note", "")
    row[17] = overrides.get("rating", "")
    row[18] = overrides.get("external", "")
    row[19] = overrides.get("tasting", "")
    return row


def test_totals_are_converted_to_unit_prices() -> None:
    """레거시 금액은 총액이다. DB 는 병당 단가를 저장하므로 여기서 환산한다."""
    report = parse_rows(
        [
            list(MAIN_HEADER),
            _row(
                list_total=" \\300,000 ",
                paid_total=" \\240,000 ",
                purchased="3",
                consumed="1",
                in_stock="2",
                unopened="1",
                opened="1",
            ),
        ]
    )
    record = report.records[0]

    assert record.list_total == Decimal(300000)
    assert record.paid_total == Decimal(240000)
    assert record.unit_list_price == Decimal("100000.00")
    assert record.unit_paid_price == Decimal("80000.00")


def test_unit_price_is_none_when_quantity_is_zero() -> None:
    report = parse_rows(
        [
            list(MAIN_HEADER),
            _row(
                list_total=" \\50,000 ",
                purchased="0",
                consumed="0",
                in_stock="0",
                unopened="0",
                opened="0",
            ),
        ]
    )
    record = report.records[0]

    assert record.list_total == Decimal(50000)
    assert record.unit_list_price is None
    assert any("병당 단가" in warning for warning in record.warnings)


def test_gift_rows_keep_bottle_counts_without_amounts() -> None:
    report = parse_rows(
        [
            list(MAIN_HEADER),
            _row(
                list_total=" \\- ",
                paid_total=" \\- ",
                purchased="2",
                consumed="2",
                in_stock="0",
                unopened="0",
                opened="0",
            ),
        ]
    )
    record = report.records[0]

    assert record.list_total is None
    assert record.purchased_count == 2
    assert record.warnings == ()


def test_bottle_count_mismatch_is_reported_as_warning() -> None:
    report = parse_rows(
        [
            list(MAIN_HEADER),
            _row(purchased="5", consumed="1", in_stock="2", unopened="2", opened="0"),
        ]
    )

    assert any("병수 정합성 불일치" in warning for warning in report.records[0].warnings)


def test_stock_composition_mismatch_is_reported() -> None:
    report = parse_rows(
        [
            list(MAIN_HEADER),
            _row(purchased="3", consumed="0", in_stock="3", unopened="1", opened="1"),
        ]
    )

    assert any("재고 구성 불일치" in warning for warning in report.records[0].warnings)


def test_category_forward_fill_applies_across_records() -> None:
    report = parse_rows(
        [
            list(MAIN_HEADER),
            _row(name="첫째", category="레드와인"),
            _row(name="둘째", category=""),
            _row(name="셋째", category="백주"),
        ]
    )
    roots = [record.category.leaf for record in report.records if record.category]

    assert roots == ["레드와인", "레드와인", "백주"]


def test_unknown_category_produces_warning_but_keeps_record() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(category="처음 보는 주종")])
    record = report.records[0]

    assert record.category is not None
    assert record.category.matched is False
    assert any("사전에 없는" in warning for warning in record.warnings)


def test_missing_category_before_first_separator_is_reported() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(category="")])
    record = report.records[0]

    assert record.category is None
    assert any("전파받지 못했습니다" in warning for warning in record.warnings)


def test_multiple_vendors_are_split_and_flagged() -> None:
    report = parse_rows(
        [list(MAIN_HEADER), _row(vendor="가상마트 1호점\n가상온라인샵\n가상보틀샵")]
    )
    record = report.records[0]

    assert record.vendors == ("가상마트 1호점", "가상온라인샵", "가상보틀샵")
    assert record.has_multiple_vendors is True


def test_foreign_price_is_extracted_from_note() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(note="$69.79 (환율 1431.9원)")])
    record = report.records[0]

    assert record.foreign_price is not None
    assert record.foreign_price.currency == "USD"
    assert record.foreign_price.fx_rate == Decimal("1431.9")


def test_vintage_is_split_from_name() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(name="가상 샤토 소테른, 2015")])
    record = report.records[0]

    assert record.name == "가상 샤토 소테른"
    assert record.vintage == 2015


def test_name_second_line_becomes_note() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(name="가상 탁주\n25/04/10 발효")])
    record = report.records[0]

    assert record.name == "가상 탁주"
    assert record.name_note == "25/04/10 발효"


def test_external_ratings_are_split_by_source() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(external="3.40 (RB)\n4.06/91 (BA)")])
    codes = [rating.source_code for rating in report.records[0].external_ratings]

    assert codes == ["RB", "BA"]


def test_unparseable_volume_and_abv_are_warned() -> None:
    report = parse_rows([list(MAIN_HEADER), _row(volume="알 수 없음", abv="")])
    record = report.records[0]

    assert record.volume_ml is None
    assert any("용량을 해석하지" in warning for warning in record.warnings)


# --- 픽스처 전체에 대한 회귀 검증 ---------------------------------------------


def test_fixture_report_counts_match_synthetic_totals(report: ParseReport) -> None:
    # 픽스처 합계행은 14/8/6/4/2 로 만들었다. 파서 결과가 이와 일치해야 한다.
    assert report.record_count == 7
    assert report.total_purchased == 14
    assert report.total_consumed == 8
    assert report.total_in_stock == 6
    assert report.total_unopened == 4
    assert report.total_opened == 2


def test_fixture_amount_totals_match_synthetic_totals(report: ParseReport) -> None:
    assert report.total_list_amount == Decimal(545980)
    assert report.total_paid_amount == Decimal(443980)


def test_fixture_volume_total_matches(report: ParseReport) -> None:
    # 750*1 + 750*2 + 375*2 + 500*2 + 900*3 + 700*3 + 500*1 = 9,300ml
    # 픽스처 합계행의 `9300ml` 와 일치해야 한다.
    assert report.total_volume_ml == 9300


def test_fixture_collects_unique_vendors(report: ParseReport) -> None:
    assert "가상마트 1호점" in report.unique_vendors
    assert "가상온라인샵" in report.unique_vendors


def test_fixture_flags_multi_vendor_and_unmatched_category(report: ParseReport) -> None:
    assert len(report.multi_vendor_records) == 1
    assert report.unmatched_categories == {"가상신주종"}


def test_fixture_parses_multiline_tasting_note(report: ParseReport) -> None:
    first = report.records[0]

    assert first.tasting_note is not None
    assert "\n" in first.tasting_note


def test_fixture_normalizes_variety_typo(report: ParseReport) -> None:
    first = report.records[0]

    assert [item.name for item in first.varieties] == ["Cabernet Sauvignon"]
