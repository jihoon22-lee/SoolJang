"""블록 분리 회귀 테스트.

실제 시트가 가진 세 가지 구조적 함정을 명시적으로 검증한다
(`docs/legacy-schema.md` §3).

1. 데이터 구간 중간의 빈 행이 종료로 오인되지 않는다
2. 본 테이블 합계행이 데이터로 적재되지 않는다
3. 좌우로 나란히 놓인 통계 블록이 데이터로 오탐되지 않는다
"""

from pathlib import Path

import pytest

from sooljang.infrastructure.legacy.blocks import (
    MAIN_HEADER,
    LegacySheetError,
    RowKind,
    classify_rows,
    load_main_block,
    read_rows,
    split_main_block,
)

FIXTURE = Path(__file__).parent / "testdata" / "sample_sheet.csv"


@pytest.fixture(scope="module")
def rows() -> list[tuple[str, ...]]:
    return read_rows(FIXTURE)


def test_fixture_is_decoded_from_cp949(rows: list[tuple[str, ...]]) -> None:
    # CP949 로 읽지 못하면 한글 헤더가 깨진다.
    assert rows[0][:4] == ("이름", "용량", "도수", "종류")


def test_logical_row_count_differs_from_physical_lines(rows: list[tuple[str, ...]]) -> None:
    # 셀 내부 개행 때문에 물리 줄 수로 위치를 판단하면 틀린다.
    physical_lines = FIXTURE.read_bytes().decode("cp949").count("\n")
    assert len(rows) < physical_lines


def test_header_signature_is_recognized(rows: list[tuple[str, ...]]) -> None:
    classified = list(classify_rows(rows))
    headers = [row for row in classified if row.kind is RowKind.HEADER]

    assert len(headers) == 1
    assert headers[0].line_number == 1


def test_blank_row_inside_data_does_not_end_the_block(rows: list[tuple[str, ...]]) -> None:
    result = split_main_block(rows)

    # 픽스처는 빈 행 앞에 3행, 뒤에 4행의 데이터를 둔다.
    assert result.record_count == 7
    assert result.skipped_blank_lines, "데이터 구간 중간의 빈 행을 통과 기록으로 남겨야 한다"
    blank_line = result.skipped_blank_lines[0]
    assert any(row.line_number < blank_line for row in result.data_rows)
    assert any(row.line_number > blank_line for row in result.data_rows)


def test_total_row_is_excluded_but_recorded(rows: list[tuple[str, ...]]) -> None:
    result = split_main_block(rows)

    assert len(result.total_row_lines) == 1
    total_line = result.total_row_lines[0]
    assert total_line not in {row.line_number for row in result.data_rows}
    # 합계행 이후의 모든 행은 배제된다.
    assert all(row.line_number < total_line for row in result.data_rows)


def test_statistics_blocks_are_not_parsed_as_data(rows: list[tuple[str, ...]]) -> None:
    result = split_main_block(rows)
    classified = {row.line_number: row for row in classify_rows(rows)}

    # 주종별 통계 헤더 행을 찾아 그 이후가 데이터로 잡히지 않았음을 확인한다.
    stats_header_line = next(
        line for line, row in classified.items() if "랭킹" in row.cells and "품목" in row.cells
    )
    assert all(row.line_number < stats_header_line for row in result.data_rows)


def test_side_by_side_rollup_matrix_is_rejected_by_shape() -> None:
    """가로 배치 블록은 합계행 도달과 무관하게 모양만으로 배제되어야 한다.

    실측 464~476 행은 이름이 비어 있지 않고 병수 컬럼이 정수라 조건 1~3 을 통과한다.
    도수 칸의 라벨·금액이 도수로 해석되지 않는 점이 유일한 방어선이다.
    """
    header = list(MAIN_HEADER)
    data = [""] * 20
    data[0] = "정상 데이터"
    data[1] = "700ml"
    data[2] = "40.0%"
    data[3] = "싱글몰트 위스키"
    data[10:15] = ["1", "0", "1", "1", "0"]

    rollup_label = [""] * 20
    rollup_label[0] = "병당 가격 상위 10위 술"
    rollup_label[2] = "병당 가격"  # 도수 칸에 라벨
    rollup_label[9] = "레드와인"
    rollup_label[10:15] = ["21", "21", "0", "0", "0"]

    rollup_money = [""] * 20
    rollup_money[0] = "글렌고인 25y"
    rollup_money[2] = " \\848,000 "  # 도수 칸에 금액
    rollup_money[9] = "화이트와인"
    rollup_money[10:15] = ["26", "17", "9", "9", "0"]

    result = split_main_block([header, data, rollup_label, rollup_money])

    assert result.record_count == 1
    assert result.data_rows[0].cells[0] == "정상 데이터"


def test_missing_header_raises() -> None:
    with pytest.raises(LegacySheetError, match="헤더"):
        split_main_block([["아무", "다른", "열"], ["1", "2", "3"]])


def test_single_malformed_row_does_not_end_the_block() -> None:
    """데이터 구간에 형식이 깨진 행 하나가 섞여도 블록을 끝내지 않는다."""
    header = list(MAIN_HEADER)

    def make(name: str) -> list[str]:
        row = [""] * 20
        row[0] = name
        row[2] = "40.0%"
        row[10:15] = ["1", "0", "1", "1", "0"]
        return row

    broken = [""] * 20
    broken[0] = "깨진 행"
    broken[2] = "알 수 없음"

    result = split_main_block([header, make("첫째"), broken, make("둘째")])

    assert [row.cells[0] for row in result.data_rows] == ["첫째", "둘째"]
    assert broken_line_excluded(result)


def broken_line_excluded(result: object) -> bool:
    return bool(getattr(result, "excluded_lines", []))


def test_two_consecutive_unknown_rows_end_the_block() -> None:
    header = list(MAIN_HEADER)
    row = [""] * 20
    row[0] = "데이터"
    row[2] = "40.0%"
    row[10:15] = ["1", "0", "1", "1", "0"]
    junk = ["설명만 있는 행"] + [""] * 19
    trailing = list(row)
    trailing[0] = "블록 밖 데이터"

    result = split_main_block([header, row, junk, list(junk), trailing])

    assert [r.cells[0] for r in result.data_rows] == ["데이터"]


def test_load_main_block_reads_from_path() -> None:
    result = load_main_block(FIXTURE)

    assert result.header == MAIN_HEADER
    assert result.record_count == 7


def test_read_rows_accepts_bytes_and_str() -> None:
    raw_bytes = FIXTURE.read_bytes()
    from_bytes = read_rows(raw_bytes)
    from_str = read_rows(raw_bytes.decode("cp949"))

    assert from_bytes == from_str
