"""단일 시트에서 본 테이블 블록만 분리한다.

레거시 시트는 술 정리 테이블과 통계 테이블 여러 개가 **세로로도 가로로도** 배치되어
있다(`docs/legacy-schema.md` §3). 단순히 행을 순서대로 읽으면 세 가지 함정에 빠진다.

1. 데이터 중간의 빈 행이 데이터 종료로 오인된다 (실측 CSV 논리 행 326)
2. 본 테이블 합계행이 데이터로 적재된다 (실측 432 — 이름이 비고 용량 칸에 `704970ml`)
3. 통계 블록의 우측 주종 롤업 매트릭스가 병수 컬럼에 정수를 가져 데이터로 오탐된다
   (실측 464~476)

그래서 "빈 행이면 종료" 대신 **행 모양(shape)으로 판정하고 빈 행은 통과**한다.
"""

import csv
import io
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

LEGACY_ENCODING = "cp949"

#: 본 테이블 헤더. 시그니처로 사용한다.
MAIN_HEADER: tuple[str, ...] = (
    "이름",
    "용량",
    "도수",
    "종류",
    "품종",
    "가격",
    "실구매가",
    "평단가",
    "실평단가",
    "100ml당 가격",
    "구매",
    "소비",
    "재고",
    "미개봉",
    "개봉",
    "구매처",
    "비고",
    "내 평점",
    "외부 평점",
    "느낀 점",
)

MAIN_COLUMN_COUNT = len(MAIN_HEADER)

#: 이름(0) 과 병수 컬럼(10~14) 의 위치. 행 모양 판정에 쓴다.
NAME_INDEX = 0
ABV_INDEX = 2
BOTTLE_COUNT_INDICES: tuple[int, ...] = (10, 11, 12, 13, 14)

#: 도수 칸이 비어 있는 것으로 취급할 표기. 엑셀 수식 오류를 포함한다.
_EMPTY_ABV_TOKENS = frozenset({"-", "–", "—", "#N/A", "#VALUE!", "#DIV/0!", "#REF!", "N/A"})

_ABV_NUMBER = re.compile(r"\d+(?:\.\d+)?")


class RowKind(Enum):
    """블록 분리에서 판정한 행의 종류."""

    HEADER = "header"
    DATA = "data"
    BLANK = "blank"
    TOTAL = "total"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class ClassifiedRow:
    """행 하나와 그 판정 결과. 진단과 회귀 테스트를 위해 행 번호를 보존한다."""

    line_number: int
    kind: RowKind
    cells: tuple[str, ...]


@dataclass(slots=True)
class BlockSplitResult:
    """본 테이블 분리 결과와 배제 내역."""

    header: tuple[str, ...]
    rows: list[ClassifiedRow] = field(default_factory=list)
    skipped_blank_lines: list[int] = field(default_factory=list)
    total_row_lines: list[int] = field(default_factory=list)
    excluded_lines: list[int] = field(default_factory=list)

    @property
    def data_rows(self) -> list[ClassifiedRow]:
        return [row for row in self.rows if row.kind is RowKind.DATA]

    @property
    def record_count(self) -> int:
        return len(self.data_rows)


class LegacySheetError(ValueError):
    """레거시 시트가 예상 구조와 다를 때 발생한다."""


def read_rows(source: Path | bytes | str) -> list[tuple[str, ...]]:
    """CP949 CSV 를 논리 행 목록으로 읽는다.

    셀 내부 개행 때문에 물리 줄 수와 논리 행 수가 다르다(실측 1,199 대 531). 위치
    판정은 반드시 **논리 행** 기준이어야 하므로 `csv` 모듈에 맡긴다.
    """
    if isinstance(source, Path):
        raw = source.read_bytes().decode(LEGACY_ENCODING)
    elif isinstance(source, bytes):
        raw = source.decode(LEGACY_ENCODING)
    else:
        raw = source
    reader = csv.reader(io.StringIO(raw, newline=""))
    return [tuple(row) for row in reader]


def _is_blank(cells: Sequence[str]) -> bool:
    return all(not cell.strip() for cell in cells)


def _looks_like_header(cells: Sequence[str]) -> bool:
    """헤더 시그니처 판정. 앞쪽 컬럼 이름이 일치하면 헤더로 본다."""
    if len(cells) < MAIN_COLUMN_COUNT:
        return False
    return tuple(cell.strip() for cell in cells[:MAIN_COLUMN_COUNT]) == MAIN_HEADER


def _is_data_shape(cells: Sequence[str]) -> bool:
    """본 테이블 데이터 행의 모양인지 판정한다.

    조건을 모두 만족해야 한다.

    1. 컬럼 수가 본 테이블과 같다
    2. 이름이 비어 있지 않다 → 합계행과 랭킹 소계행을 배제한다
    3. 병수 컬럼 5개가 모두 정수다 → 통계 블록 본문을 배제한다
    4. 도수 칸이 비어 있지 않다면 유효한 도수(0~100)여야 한다

    조건 4 가 가로 배치 블록 방어의 핵심이다. 실측 464~476 행은 좌측에 랭킹 제목·품목명이,
    우측(컬럼 9~14)에 주종 롤업 병수가 놓여 있어 조건 1~3 을 모두 통과한다. 그러나 도수
    칸에는 `병당 가격` 같은 라벨이나 `\\848,000` 같은 금액이 들어 있어 도수로 해석되지
    않는다. 합계행 도달로 블록을 끝내는 것만으로도 실측 파일은 처리되지만, 합계행이 없는
    시트에서도 안전하도록 모양 자체로 판정한다.
    """
    if len(cells) < MAIN_COLUMN_COUNT:
        return False
    if not cells[NAME_INDEX].strip():
        return False
    for index in BOTTLE_COUNT_INDICES:
        text = cells[index].strip()
        if not text or not text.isdigit():
            return False
    return _is_plausible_abv(cells[ABV_INDEX])


def _is_plausible_abv(cell: str) -> bool:
    """도수 칸이 비어 있거나 0~100 범위의 수치인지 판정한다."""
    text = cell.strip()
    if not text or text in _EMPTY_ABV_TOKENS:
        return True
    match = _ABV_NUMBER.search(text.replace(",", ""))
    if match is None:
        return False
    return 0.0 <= float(match.group()) <= 100.0


def _is_total_shape(cells: Sequence[str]) -> bool:
    """본 테이블 합계행 모양인지 판정한다.

    이름은 비어 있으나 병수 컬럼이 모두 정수인 행이다(실측 432). 데이터가 아니지만
    검증 대조에 쓸 수 있어 별도로 표시해 둔다.
    """
    if len(cells) < MAIN_COLUMN_COUNT:
        return False
    if cells[NAME_INDEX].strip():
        return False
    return all(cells[index].strip().isdigit() for index in BOTTLE_COUNT_INDICES)


def classify_rows(rows: Sequence[Sequence[str]]) -> Iterator[ClassifiedRow]:
    """모든 행을 종류별로 판정한다. 행 번호는 1-based 논리 행 번호다."""
    for line_number, cells in enumerate(rows, start=1):
        tupled = tuple(cells)
        if _looks_like_header(tupled):
            kind = RowKind.HEADER
        elif _is_blank(tupled):
            kind = RowKind.BLANK
        elif _is_data_shape(tupled):
            kind = RowKind.DATA
        elif _is_total_shape(tupled):
            kind = RowKind.TOTAL
        else:
            kind = RowKind.OTHER
        yield ClassifiedRow(line_number=line_number, kind=kind, cells=tupled)


def split_main_block(rows: Sequence[Sequence[str]]) -> BlockSplitResult:
    """본 테이블 블록만 추출한다.

    헤더를 찾은 뒤 아래로 훑으며 데이터 행을 모은다. 빈 행은 **종료가 아니라 통과**
    대상이다. 합계행을 만나면 본 테이블이 끝난 것으로 보고 중단한다. 합계행 없이
    통계 블록이 시작되는 경우를 대비해, 데이터도 합계도 아닌 행이 연속 2회 나오면
    중단한다. 한 번만으로 중단하지 않는 이유는 데이터 구간 안에 형식이 깨진 행이
    하나 섞여 있을 수 있기 때문이다.
    """
    classified = list(classify_rows(rows))
    header_row = next((row for row in classified if row.kind is RowKind.HEADER), None)
    if header_row is None:
        raise LegacySheetError(
            "본 테이블 헤더를 찾지 못했습니다. 첫 행이 다음과 같아야 합니다: "
            + ", ".join(MAIN_HEADER)
        )

    result = BlockSplitResult(header=MAIN_HEADER)
    consecutive_other = 0
    ended = False

    for row in classified:
        if row.line_number <= header_row.line_number:
            continue
        if ended:
            result.excluded_lines.append(row.line_number)
            continue

        match row.kind:
            case RowKind.DATA:
                consecutive_other = 0
                result.rows.append(row)
            case RowKind.BLANK:
                # 데이터 종료가 아니다. 실측 326 행이 여기에 해당한다.
                result.skipped_blank_lines.append(row.line_number)
            case RowKind.TOTAL:
                result.total_row_lines.append(row.line_number)
                result.excluded_lines.append(row.line_number)
                ended = True
            case RowKind.HEADER:
                # 통계 블록이 같은 헤더를 반복하는 경우는 없지만 방어한다.
                result.excluded_lines.append(row.line_number)
                ended = True
            case RowKind.OTHER:
                consecutive_other += 1
                result.excluded_lines.append(row.line_number)
                if consecutive_other >= 2:
                    ended = True

    return result


def load_main_block(source: Path | bytes | str) -> BlockSplitResult:
    """파일에서 본 테이블 블록을 읽어 분리한다."""
    return split_main_block(read_rows(source))
