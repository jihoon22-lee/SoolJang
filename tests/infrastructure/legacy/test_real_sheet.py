"""실제 레거시 시트에 대한 대조 검증 (opt-in).

실제 개인 기록은 저장소에 커밋하지 않으므로 기본적으로 건너뛴다. 파일 경로를 환경 변수로
지정하면 실행되며, `docs/legacy-schema.md` §5 의 검증 기준값과 대조한다.

    SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet

Task 11(임포터)이 같은 기준값을 재사용한다. 파서 단계에서 이미 어긋나면 임포터를 만들 이유가
없으므로 여기서 먼저 확인한다.
"""

import os
from decimal import Decimal
from pathlib import Path

import pytest

from sooljang.infrastructure.legacy.records import ParseReport, parse_sheet

pytestmark = pytest.mark.requires_legacy_sheet

#: `docs/legacy-schema.md` §5 검증 기준값
EXPECTED_RECORD_COUNT = 429
EXPECTED_PURCHASED = 1078
EXPECTED_CONSUMED = 819
EXPECTED_IN_STOCK = 259
EXPECTED_UNOPENED = 225
EXPECTED_OPENED = 34
EXPECTED_LIST_TOTAL = Decimal(42401108)
EXPECTED_PAID_TOTAL = Decimal(36495454)
EXPECTED_VOLUME_ML = 704970
EXPECTED_UNIQUE_VENDORS = 82
EXPECTED_MULTI_VENDOR_ROWS = 28

# 엑셀 셀 서식이 원 단위 미만을 절삭해 표시하므로 합계행과 소액 차이가 난다.
DISPLAY_ROUNDING_TOLERANCE = Decimal(10)


def _sheet_path() -> Path:
    raw = os.environ.get("SOOLJANG_LEGACY_SHEET")
    if not raw:
        pytest.skip("SOOLJANG_LEGACY_SHEET 가 지정되지 않았습니다")
    path = Path(raw)
    if not path.exists():
        pytest.skip(f"레거시 시트를 찾을 수 없습니다: {path}")
    return path


@pytest.fixture(scope="module")
def report() -> ParseReport:
    return parse_sheet(_sheet_path())


def test_record_count_matches_measured_value(report: ParseReport) -> None:
    assert report.record_count == EXPECTED_RECORD_COUNT


def test_bottle_count_totals_match_sheet_total_row(report: ParseReport) -> None:
    assert report.total_purchased == EXPECTED_PURCHASED
    assert report.total_consumed == EXPECTED_CONSUMED
    assert report.total_in_stock == EXPECTED_IN_STOCK
    assert report.total_unopened == EXPECTED_UNOPENED
    assert report.total_opened == EXPECTED_OPENED


def test_bottle_count_totals_are_internally_consistent(report: ParseReport) -> None:
    assert report.total_purchased - report.total_consumed == report.total_in_stock
    assert report.total_unopened + report.total_opened == report.total_in_stock


def test_amount_totals_match_within_display_rounding(report: ParseReport) -> None:
    assert abs(report.total_list_amount - EXPECTED_LIST_TOTAL) <= DISPLAY_ROUNDING_TOLERANCE
    assert abs(report.total_paid_amount - EXPECTED_PAID_TOTAL) <= DISPLAY_ROUNDING_TOLERANCE


def test_volume_total_matches(report: ParseReport) -> None:
    assert report.total_volume_ml == EXPECTED_VOLUME_ML


def test_every_record_receives_a_category(report: ParseReport) -> None:
    """`종류` forward-fill 이 전체 행을 덮어야 한다. 전파 실패는 0건이어야 한다."""
    missing = [record.line_number for record in report.records if record.category is None]

    assert missing == []


def test_unique_vendor_count_matches(report: ParseReport) -> None:
    assert len(report.unique_vendors) == EXPECTED_UNIQUE_VENDORS


def test_multi_vendor_rows_are_detected(report: ParseReport) -> None:
    assert len(report.multi_vendor_records) == EXPECTED_MULTI_VENDOR_ROWS


def test_statistics_blocks_are_excluded(report: ParseReport) -> None:
    """합계행 이후의 통계 블록이 데이터로 잡히지 않아야 한다."""
    assert report.block is not None
    assert report.block.total_row_lines, "본 테이블 합계행을 찾아야 한다"
    total_line = report.block.total_row_lines[0]
    assert all(record.line_number < total_line for record in report.records)


def test_blank_row_inside_data_was_passed_through(report: ParseReport) -> None:
    assert report.block is not None
    assert report.block.skipped_blank_lines, "데이터 구간 중간의 빈 행을 통과해야 한다"


def test_vintage_extraction_finds_expected_row_count(report: ParseReport) -> None:
    # 실측: 이름이 `, YYYY` 로 끝나는 행 99개
    with_vintage = [record for record in report.records if record.vintage is not None]

    assert len(with_vintage) == 99


def test_external_rating_source_tags_are_recognized(report: ParseReport) -> None:
    # 실측 태그 분포: 무태그 107, RB 28, U 19, BA 18
    codes: dict[str | None, int] = {}
    for record in report.records:
        for rating in record.external_ratings:
            codes[rating.source_code] = codes.get(rating.source_code, 0) + 1

    assert codes.get("RB") == 28
    assert codes.get("U") == 19
    assert codes.get("BA") == 18
    assert codes.get(None) == 107


def test_foreign_currency_rows_are_detected(report: ParseReport) -> None:
    # 실측: 비고에 외화·환율이 적힌 행 15개
    with_foreign = [record for record in report.records if record.foreign_price is not None]

    assert len(with_foreign) == 15


def test_unit_prices_reproduce_sheet_average_columns(report: ParseReport) -> None:
    """총액 ÷ 병수 환산이 시트의 평단가 컬럼과 일치해야 한다.

    `docs/legacy-schema.md` §4.2 에서 391건 일치·불일치 0 으로 검증한 관계다. 파서가
    같은 결과를 내는지 확인한다.
    """
    from sooljang.infrastructure.legacy.blocks import read_rows
    from sooljang.infrastructure.legacy.normalize import parse_money
    from sooljang.infrastructure.legacy.records import COL_LIST_UNIT

    rows = read_rows(_sheet_path())
    compared = mismatched = 0

    for record in report.records:
        sheet_unit = parse_money(rows[record.line_number - 1][COL_LIST_UNIT])
        if sheet_unit is None or record.unit_list_price is None:
            continue
        compared += 1
        # 시트 값은 원 단위로 절삭 표시되므로 1원 이내 차이를 허용한다.
        if abs(record.unit_list_price - sheet_unit) > Decimal("1.5"):
            mismatched += 1

    assert compared >= 380
    assert mismatched == 0
