"""레거시 임포트 계획 수립.

파서(`infrastructure.legacy`)가 만든 레코드를 **DB 에 넣기 전에** 무엇이 생기고 무엇이 문제인지
먼저 계산한다. 미리보기 없이 바로 적재하면 잘못된 매핑을 되돌리기 어렵다.

이 모듈은 DB 를 건드리지 않는다. 계획을 값으로 만들어 두면 dry-run 과 실제 적재가 같은 계획을
쓰게 되어 "미리 본 것과 다른 결과" 가 나오지 않는다.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal

from sooljang.infrastructure.legacy.records import LegacyRecord, ParseReport

#: 구매처 문자열에서 병수 힌트를 뽑는 패턴.
#: 실측 예: `스타보틀 인계 * 3`, `이마트 스마트오더 1`
_QUANTITY_SUFFIX = re.compile(r"^(?P<name>.*?)\s*(?:\*\s*(?P<star>\d+)|(?P<plain>\d+))\s*$")
#: 괄호 안 숫자는 만원 단위 가격 메모다. 병수가 아니다. 실측 예: `레투와(9.1)`
_PRICE_HINT = re.compile(r"\((?P<price>\d+(?:\.\d+)?)\)\s*$")


@dataclass(frozen=True, slots=True)
class VendorShare:
    """구매처 하나와 그 구매처에서 산 병수."""

    name: str
    quantity: int
    raw: str


@dataclass(frozen=True, slots=True)
class PlannedPurchase:
    """만들 구매 건 하나."""

    vendor_name: str | None
    quantity: int
    unit_list_price: Decimal | None
    unit_paid_price: Decimal | None
    currency: str
    fx_rate: Decimal | None
    foreign_unit_price: Decimal | None
    discount_note: str | None
    import_note: str | None
    #: 상태별 병수. 레거시는 개별 병을 구분하지 않으므로 개수로만 초기화한다.
    unopened: int
    opened: int
    finished: int


@dataclass(frozen=True, slots=True)
class PlannedProduct:
    """만들 제품 하나와 그에 딸린 규격·구매 건."""

    line_number: int
    name: str
    normalized_name: str
    vintage: int | None
    abv: Decimal | None
    category_path: tuple[str, ...]
    variety_names: tuple[str, ...]
    volume_ml: int | None
    personal_rating: Decimal | None
    note: str | None
    external_ratings: tuple[tuple[str | None, Decimal], ...]
    purchases: tuple[PlannedPurchase, ...]
    warnings: tuple[str, ...]

    @property
    def identity(self) -> tuple[str, int | None, Decimal | None]:
        """제품 중복 판정 키. DB 의 유일 인덱스와 같은 조합이다."""
        return (self.normalized_name, self.vintage, self.abv)

    @property
    def total_quantity(self) -> int:
        return sum(purchase.quantity for purchase in self.purchases)


@dataclass(slots=True)
class ImportPlan:
    """임포트 계획 전체. dry-run 응답과 실제 적재가 같은 값을 쓴다."""

    products: list[PlannedProduct] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: 같은 제품으로 판정되어 합쳐질 행 묶음. 사용자가 확인해야 한다.
    merge_groups: dict[tuple[str, int | None, Decimal | None], list[int]] = field(
        default_factory=dict
    )

    @property
    def product_count(self) -> int:
        """만들어질 제품 수. 중복 판정으로 합쳐진 것은 하나로 센다."""
        return len({product.identity for product in self.products})

    @property
    def source_row_count(self) -> int:
        return len(self.products)

    @property
    def sku_count(self) -> int:
        return len(
            {
                (product.identity, product.volume_ml)
                for product in self.products
                if product.volume_ml is not None
            }
        )

    @property
    def purchase_count(self) -> int:
        return sum(len(product.purchases) for product in self.products)

    @property
    def bottle_count(self) -> int:
        return sum(product.total_quantity for product in self.products)

    @property
    def vendor_names(self) -> set[str]:
        return {
            purchase.vendor_name
            for product in self.products
            for purchase in product.purchases
            if purchase.vendor_name
        }

    @property
    def category_paths(self) -> set[tuple[str, ...]]:
        return {product.category_path for product in self.products if product.category_path}

    @property
    def variety_names(self) -> set[str]:
        return {name for product in self.products for name in product.variety_names}

    @property
    def total_list_amount(self) -> Decimal:
        return sum(
            (
                purchase.unit_list_price * Decimal(purchase.quantity)
                for product in self.products
                for purchase in product.purchases
                if purchase.unit_list_price is not None
            ),
            Decimal(0),
        )

    @property
    def total_paid_amount(self) -> Decimal:
        return sum(
            (
                purchase.unit_paid_price * Decimal(purchase.quantity)
                for product in self.products
                for purchase in product.purchases
                if purchase.unit_paid_price is not None
            ),
            Decimal(0),
        )

    @property
    def total_volume_ml(self) -> int:
        return sum(
            product.volume_ml * product.total_quantity
            for product in self.products
            if product.volume_ml is not None
        )

    @property
    def split_vendor_rows(self) -> list[int]:
        """구매처가 여러 건으로 나뉜 행. 분할이 성공한 경우다."""
        return [product.line_number for product in self.products if len(product.purchases) > 1]

    @property
    def unsplit_vendor_rows(self) -> list[int]:
        """구매처가 여러 개였으나 분할하지 못한 행. 사용자가 UI 에서 쪼개야 한다."""
        return [
            product.line_number
            for product in self.products
            if len(product.purchases) == 1
            and product.purchases[0].import_note is not None
            and "\n" in product.purchases[0].import_note
        ]


def parse_vendor_shares(raw_vendors: tuple[str, ...], total_quantity: int) -> list[VendorShare]:
    """구매처 문자열을 병수와 함께 분해한다.

    레거시 28행이 한 셀에 여러 구매처를 개행으로 담고 있고 형식이 통일되지 않았다
    (`docs/legacy-schema.md` §4.6). 병수 힌트가 있으면 쓰고, 합계가 `구매` 병수와 맞지 않으면
    **분할을 포기한다.** 억지로 나누면 병수와 금액이 어긋난 채 적재된다.

    괄호 안 숫자는 만원 단위 가격 메모이므로 병수로 오인하지 않는다.
    """
    if not raw_vendors:
        return []
    if len(raw_vendors) == 1:
        return [VendorShare(name=raw_vendors[0], quantity=total_quantity, raw=raw_vendors[0])]

    shares: list[VendorShare] = []
    for raw in raw_vendors:
        text = _PRICE_HINT.sub("", raw).strip()
        match = _QUANTITY_SUFFIX.match(text)
        if match is None:
            shares.append(VendorShare(name=text, quantity=0, raw=raw))
            continue
        quantity = int(match.group("star") or match.group("plain") or 0)
        name = match.group("name").strip()
        shares.append(VendorShare(name=name or text, quantity=quantity, raw=raw))

    hinted = sum(share.quantity for share in shares)
    if hinted == total_quantity and all(share.quantity > 0 for share in shares):
        return shares

    # 힌트가 없거나 합계가 어긋난다. 병수를 균등 분배할 수도 있지만, 그러면 실제와 다른
    # 금액이 기록된다. 원문을 보존하고 단일 구매 건으로 남긴다.
    return []


def build_plan(report: ParseReport) -> ImportPlan:
    """파싱 리포트를 임포트 계획으로 바꾼다."""
    plan = ImportPlan(warnings=list(report.warnings))

    for record in report.records:
        planned = _plan_product(record)
        plan.products.append(planned)

    grouped: dict[tuple[str, int | None, Decimal | None], list[int]] = {}
    for product in plan.products:
        grouped.setdefault(product.identity, []).append(product.line_number)
    plan.merge_groups = {key: lines for key, lines in grouped.items() if len(lines) > 1}

    return plan


def _plan_product(record: LegacyRecord) -> PlannedProduct:
    warnings = list(record.warnings)
    shares = parse_vendor_shares(record.vendors, record.purchased_count)

    note_parts = [part for part in (record.name_note, record.tasting_note) if part]
    note = "\n".join(note_parts) or None

    if len(record.vendors) > 1 and not shares:
        warnings.append(
            f"구매처가 {len(record.vendors)}곳인데 병수를 나눌 수 없어 단일 구매 건으로 "
            "적재합니다. 나중에 구매 건 분할로 쪼갤 수 있습니다"
        )

    purchases = _plan_purchases(record, shares)

    return PlannedProduct(
        line_number=record.line_number,
        name=record.name,
        normalized_name=record.normalized_name,
        vintage=record.vintage,
        abv=record.abv,
        category_path=record.category.path if record.category else (),
        variety_names=tuple(item.name for item in record.varieties),
        volume_ml=record.volume_ml,
        personal_rating=record.personal_rating,
        note=note,
        external_ratings=tuple(
            (rating.source_code, rating.value) for rating in record.external_ratings
        ),
        purchases=tuple(purchases),
        warnings=tuple(warnings),
    )


def _plan_purchases(record: LegacyRecord, shares: list[VendorShare]) -> list[PlannedPurchase]:
    """구매 건 계획. 병 상태 개수를 조각에 순서대로 배분한다."""
    if record.purchased_count <= 0:
        return []

    foreign = record.foreign_price
    # 환율이 없으면 외화 필드를 채우지 않는다. DB 는 외화 가격에 환율을 요구하고(원화 환산을
    # 재현할 수 없으므로), 그 제약을 위반하는 행을 만들면 임포트가 실패한다. 원문은
    # `discount_note` 에 남아 있어 사용자가 나중에 환율을 채울 수 있다.
    has_usable_fx = foreign is not None and foreign.fx_rate is not None
    common = {
        "unit_list_price": record.unit_list_price,
        "unit_paid_price": record.unit_paid_price,
        "currency": foreign.currency if has_usable_fx and foreign else "KRW",
        "fx_rate": foreign.fx_rate if has_usable_fx and foreign else None,
        "foreign_unit_price": foreign.amount if has_usable_fx and foreign else None,
        "discount_note": record.note,
    }

    if not shares:
        # 분할하지 않은 경우. 구매처 원문을 그대로 보존한다.
        raw_vendors = "\n".join(record.vendors) if record.vendors else None
        return [
            PlannedPurchase(
                vendor_name=record.vendors[0] if len(record.vendors) == 1 else None,
                quantity=record.purchased_count,
                import_note=raw_vendors if raw_vendors and "\n" in raw_vendors else None,
                unopened=record.unopened_count,
                opened=record.opened_count,
                finished=record.consumed_count,
                **common,  # type: ignore[arg-type]
            )
        ]

    remaining = {
        "unopened": record.unopened_count,
        "opened": record.opened_count,
        "finished": record.consumed_count,
    }
    purchases: list[PlannedPurchase] = []
    for share in shares:
        allotted = _allot(remaining, share.quantity)
        purchases.append(
            PlannedPurchase(
                vendor_name=share.name,
                quantity=share.quantity,
                import_note=share.raw if share.raw != share.name else None,
                unopened=allotted["unopened"],
                opened=allotted["opened"],
                finished=allotted["finished"],
                **common,  # type: ignore[arg-type]
            )
        )
    return purchases


def _allot(remaining: dict[str, int], quantity: int) -> dict[str, int]:
    """남은 상태 병수에서 `quantity` 만큼 꺼낸다.

    소진 → 개봉 → 미개봉 순으로 배분한다. 어느 병이 어느 구매처에서 왔는지 레거시는 모르므로
    임의 규칙이지만, 상태별 총합이 보존되는 것이 중요하다.
    """
    result = {"finished": 0, "opened": 0, "unopened": 0}
    left = quantity
    for key in ("finished", "opened", "unopened"):
        take = min(left, remaining[key])
        result[key] = take
        remaining[key] -= take
        left -= take
    if left > 0:
        # 상태 합계가 구매 병수보다 적은 경우다. 남는 병은 미개봉으로 둔다.
        result["unopened"] += left
    return result


def summarize_warnings(plan: ImportPlan) -> list[tuple[str, int]]:
    """경고를 종류별로 묶어 개수와 함께 반환한다. 429행의 경고를 그대로 보여주면 읽을 수 없다."""
    counter: Counter[str] = Counter()
    for product in plan.products:
        for warning in product.warnings:
            counter[_warning_kind(warning)] += 1
    return counter.most_common()


def _warning_kind(warning: str) -> str:
    """경고 문장에서 종류만 추출한다. 값이 섞인 부분을 잘라 묶을 수 있게 한다."""
    for marker in (":", "("):
        if marker in warning:
            return warning.split(marker)[0].strip()
    return warning
