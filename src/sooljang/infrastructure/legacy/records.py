"""본 테이블 행을 구조화된 레코드로 변환한다.

핵심 변환은 **총액 → 병당 단가**다. 레거시 `가격`·`실구매가`는 병당 단가가 아니라 해당
술의 총액이고, `평단가 = 가격 ÷ 구매 병수` 를 391건으로 검증했다
(`docs/legacy-schema.md` §4.2). DB 는 병당 단가를 저장하므로 여기서 환산한다.

파싱 실패는 예외를 던지지 않고 `warnings` 에 모은다. 429행 중 한 행의 이상값이 전체
임포트를 중단시키면 사용자는 아무것도 얻지 못한다.
"""

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from sooljang.infrastructure.legacy.blocks import (
    BlockSplitResult,
    load_main_block,
    split_main_block,
)
from sooljang.infrastructure.legacy.categories import (
    CategoryResolution,
    forward_fill_categories,
    resolve_category,
)
from sooljang.infrastructure.legacy.normalize import (
    ExternalRatingValue,
    ForeignPrice,
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
from sooljang.infrastructure.legacy.varieties import VarietyResolution, normalize_varieties

# 컬럼 인덱스. blocks.MAIN_HEADER 순서와 대응한다.
COL_NAME = 0
COL_VOLUME = 1
COL_ABV = 2
COL_CATEGORY = 3
COL_VARIETY = 4
COL_LIST_TOTAL = 5
COL_PAID_TOTAL = 6
COL_LIST_UNIT = 7
COL_PAID_UNIT = 8
COL_PER_100ML = 9
COL_PURCHASED = 10
COL_CONSUMED = 11
COL_IN_STOCK = 12
COL_UNOPENED = 13
COL_OPENED = 14
COL_VENDOR = 15
COL_NOTE = 16
COL_PERSONAL_RATING = 17
COL_EXTERNAL_RATING = 18
COL_TASTING_NOTE = 19

_CENT = Decimal("0.01")


@dataclass(frozen=True, slots=True)
class LegacyRecord:
    """본 테이블 한 행에서 추출한 레코드."""

    line_number: int
    name: str
    normalized_name: str
    name_note: str | None
    vintage: int | None
    volume_ml: int | None
    abv: Decimal | None
    category: CategoryResolution | None
    varieties: tuple[VarietyResolution, ...]
    # 총액 (레거시 원본)
    list_total: Decimal | None
    paid_total: Decimal | None
    # 병당 단가 (환산 결과)
    unit_list_price: Decimal | None
    unit_paid_price: Decimal | None
    purchased_count: int
    consumed_count: int
    in_stock_count: int
    unopened_count: int
    opened_count: int
    vendors: tuple[str, ...]
    note: str | None
    foreign_price: ForeignPrice | None
    personal_rating: Decimal | None
    external_ratings: tuple[ExternalRatingValue, ...]
    tasting_note: str | None
    warnings: tuple[str, ...] = ()

    @property
    def has_multiple_vendors(self) -> bool:
        """구매처가 여러 개면 구매 건 분할 후보다. 형식이 불규칙해 자동 분해가 어렵다."""
        return len(self.vendors) > 1


@dataclass(slots=True)
class ParseReport:
    """파싱 결과 요약. 임포트 dry-run 미리보기와 회귀 테스트에 쓴다."""

    records: list[LegacyRecord] = field(default_factory=list)
    block: BlockSplitResult | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def record_count(self) -> int:
        return len(self.records)

    @property
    def total_purchased(self) -> int:
        return sum(record.purchased_count for record in self.records)

    @property
    def total_consumed(self) -> int:
        return sum(record.consumed_count for record in self.records)

    @property
    def total_in_stock(self) -> int:
        return sum(record.in_stock_count for record in self.records)

    @property
    def total_unopened(self) -> int:
        return sum(record.unopened_count for record in self.records)

    @property
    def total_opened(self) -> int:
        return sum(record.opened_count for record in self.records)

    @property
    def total_list_amount(self) -> Decimal:
        return sum((r.list_total for r in self.records if r.list_total), Decimal(0))

    @property
    def total_paid_amount(self) -> Decimal:
        return sum((r.paid_total for r in self.records if r.paid_total), Decimal(0))

    @property
    def total_volume_ml(self) -> int:
        return sum(r.volume_ml * r.purchased_count for r in self.records if r.volume_ml is not None)

    @property
    def unique_vendors(self) -> set[str]:
        return {vendor for record in self.records for vendor in record.vendors}

    @property
    def multi_vendor_records(self) -> list[LegacyRecord]:
        return [record for record in self.records if record.has_multiple_vendors]

    @property
    def unmatched_categories(self) -> set[str]:
        return {
            record.category.raw
            for record in self.records
            if record.category is not None and not record.category.matched
        }


def _cell(cells: tuple[str, ...], index: int) -> str:
    return cells[index] if index < len(cells) else ""


def _unit_price(total: Decimal | None, quantity: int) -> Decimal | None:
    """총액을 병당 단가로 환산한다. 병수가 0이면 환산할 수 없다."""
    if total is None or quantity <= 0:
        return None
    return (total / Decimal(quantity)).quantize(_CENT, rounding=ROUND_HALF_UP)


def build_records(block: BlockSplitResult) -> ParseReport:
    """분리된 본 테이블 블록을 레코드 목록으로 변환한다."""
    report = ParseReport(block=block)
    data_rows = block.data_rows

    # `종류` 는 그룹 구분자이므로 먼저 forward-fill 한다.
    raw_categories: list[str | None] = [_cell(row.cells, COL_CATEGORY) for row in data_rows]
    filled_categories = forward_fill_categories(raw_categories)

    for row, raw_category in zip(data_rows, filled_categories, strict=True):
        cells = row.cells
        warnings: list[str] = []

        display_name, name_note = split_name_and_note(_cell(cells, COL_NAME))
        name, vintage = extract_vintage(display_name)

        volume_ml = parse_volume_ml(_cell(cells, COL_VOLUME))
        if volume_ml is None and not is_empty_token(_cell(cells, COL_VOLUME)):
            warnings.append(f"용량을 해석하지 못했습니다: {_cell(cells, COL_VOLUME)!r}")

        abv = parse_abv(_cell(cells, COL_ABV))
        if abv is None and not is_empty_token(_cell(cells, COL_ABV)):
            warnings.append(f"도수를 해석하지 못했습니다: {_cell(cells, COL_ABV)!r}")

        category = resolve_category(raw_category)
        if category is None:
            warnings.append("주종을 전파받지 못했습니다 (첫 그룹 구분자 이전 행)")
        elif not category.matched:
            warnings.append(f"주종 사전에 없는 값입니다: {category.raw!r}")

        purchased = parse_int(_cell(cells, COL_PURCHASED)) or 0
        consumed = parse_int(_cell(cells, COL_CONSUMED)) or 0
        in_stock = parse_int(_cell(cells, COL_IN_STOCK)) or 0
        unopened = parse_int(_cell(cells, COL_UNOPENED)) or 0
        opened = parse_int(_cell(cells, COL_OPENED)) or 0

        if purchased - consumed != in_stock:
            warnings.append(
                f"병수 정합성 불일치: 구매 {purchased} - 소비 {consumed} != 재고 {in_stock}"
            )
        if unopened + opened != in_stock:
            warnings.append(
                f"재고 구성 불일치: 미개봉 {unopened} + 개봉 {opened} != 재고 {in_stock}"
            )

        list_total = parse_money(_cell(cells, COL_LIST_TOTAL))
        paid_total = parse_money(_cell(cells, COL_PAID_TOTAL))
        unit_list = _unit_price(list_total, purchased)
        unit_paid = _unit_price(paid_total, purchased)
        if list_total is not None and unit_list is None:
            warnings.append("총액은 있으나 구매 병수가 0이라 병당 단가를 계산할 수 없습니다")

        note = _cell(cells, COL_NOTE).strip() or None
        foreign_price = parse_foreign_price(note)

        record = LegacyRecord(
            line_number=row.line_number,
            name=name,
            normalized_name=normalize_name_for_matching(name),
            name_note=name_note,
            vintage=vintage,
            volume_ml=volume_ml,
            abv=abv,
            category=category,
            varieties=tuple(normalize_varieties(split_multivalue(_cell(cells, COL_VARIETY)))),
            list_total=list_total,
            paid_total=paid_total,
            unit_list_price=unit_list,
            unit_paid_price=unit_paid,
            purchased_count=purchased,
            consumed_count=consumed,
            in_stock_count=in_stock,
            unopened_count=unopened,
            opened_count=opened,
            vendors=tuple(split_multivalue(_cell(cells, COL_VENDOR))),
            note=note,
            foreign_price=foreign_price,
            personal_rating=parse_rating(_cell(cells, COL_PERSONAL_RATING)),
            external_ratings=tuple(parse_external_ratings(_cell(cells, COL_EXTERNAL_RATING))),
            tasting_note=_cell(cells, COL_TASTING_NOTE).strip() or None,
            warnings=tuple(warnings),
        )
        report.records.append(record)
        report.warnings.extend(f"{row.line_number}행: {message}" for message in warnings)

    return report


def parse_sheet(source: Path | bytes | str) -> ParseReport:
    """파일에서 본 테이블을 읽어 레코드로 변환한다."""
    return build_records(load_main_block(source))


def parse_rows(rows: list[list[str]]) -> ParseReport:
    """이미 읽은 행 목록을 레코드로 변환한다. 테스트 편의용이다."""
    return build_records(split_main_block(rows))
