"""통계 대시보드 집계.

`docs/architecture.md` §4.2 의 `GET /stats/rankings`·`/stats/by-category`·`/stats/summary`
를 구현한다. 제품 규모(수백 건)가 크지 않아 `product_stats_rows_query` 로 전체 행을 한 번에
읽고 파이썬에서 집계한다. 대량 데이터(Task 21 의 10배 규모 검증)에서 느려지면 그때 SQL
집계로 옮긴다.

**랭킹 기준은 레거시 엑셀 실측 랭킹 블록과 대조해 확정했다** (`docs/legacy-schema.md` §3,
464~531행 원본 대조. 상세 근거는 `docs/plan.md` §5 결정 로그 참조):

- "병당 가격"·"총 구매액" 랭킹은 **실구매가 기준**이다. 정가 기준으로 계산하면 엑셀
  소계와 맞지 않는다
- "100ml당 가격" 랭킹은 기존 정가 기준(D5)을 그대로 따른다. 실측 대조 결과 정가 기준일 때만
  소계(₩1,303,064)가 일치했다
- "총 구매액" 랭킹은 상위 20건 소계까지 완전히 재현되지는 않는다. 이 앱은 같은 제품의
  반복 구매를 하나로 합산하기 때문이다(§9.3 4계층 모델의 핵심 목적). 엑셀은 행 단위였어서
  반복 구매가 별도 항목으로 남아 있었다 — 병합 후 값이 달라지는 것은 결함이 아니라 엑셀의
  한계를 해결한 결과다
"""

import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.categories import CategoryNode, descendant_ids_query, load_tree
from sooljang.domain.metrics import quantize_money, quantize_ratio, value_for_money
from sooljang.infrastructure.database.metrics_sql import (
    product_stats_rows_query,
    purchase_stats_rows_query,
)
from sooljang.infrastructure.database.models import Product, Purchase, Sku, Vendor

#: 랭킹 하나당 기본 상위 건수.
DEFAULT_RANKING_LIMIT = 10
#: 주종이 없는 제품(카테고리 미지정)을 묶는 이름.
UNCATEGORIZED_LABEL = "미분류"
#: 구매처·국가·빈티지가 없는 구매 건을 묶는 이름(Task 20 피벗).
UNKNOWN_LABEL = "미상"

GroupDimension = Literal["category", "vendor", "country", "vintage_decade"]
PivotMetric = Literal[
    "bottle_count",
    "list_total",
    "paid_total",
    "avg_price_per_100ml",
    "avg_rating",
    "discount_rate",
    "value_for_money",
]
GROUP_DIMENSIONS: tuple[GroupDimension, ...] = ("category", "vendor", "country", "vintage_decade")
PIVOT_METRICS: tuple[PivotMetric, ...] = (
    "bottle_count",
    "list_total",
    "paid_total",
    "avg_price_per_100ml",
    "avg_rating",
    "discount_rate",
    "value_for_money",
)


@dataclass(frozen=True, slots=True)
class RankingEntry:
    product_id: uuid.UUID
    product_name: str
    value: Decimal


@dataclass(frozen=True, slots=True)
class Rankings:
    by_bottle_price: list[RankingEntry]
    by_total_spend: list[RankingEntry]
    by_price_per_100ml: list[RankingEntry]
    by_personal_rating: list[RankingEntry]


@dataclass(frozen=True, slots=True)
class CategoryStat:
    category_id: uuid.UUID | None
    name: str
    bottle_count: int
    total_spend: Decimal | None
    avg_abv: Decimal | None
    avg_rating: Decimal | None
    avg_price_per_100ml: Decimal | None
    discount_rate: Decimal | None


@dataclass(frozen=True, slots=True)
class StatsSummary:
    purchased_count: int
    consumed_count: int
    in_stock_count: int
    unopened_count: int
    opened_count: int
    total_volume_ml: int
    list_total: Decimal | None
    paid_total: Decimal | None
    avg_list_price: Decimal | None
    avg_paid_price: Decimal | None
    avg_price_per_100ml: Decimal | None
    discount_rate: Decimal | None
    avg_personal_rating: Decimal | None
    vendor_count: int


def _money(value: Any) -> Decimal | None:
    return None if value is None else quantize_money(Decimal(str(value)))


def _sum_decimal(values: Iterable[Any]) -> Decimal | None:
    """None 을 건너뛰고 합산한다. 값이 하나도 없으면 None (0원과 구분해야 한다)."""
    total = Decimal(0)
    found = False
    for value in values:
        if value is None:
            continue
        found = True
        total += Decimal(str(value))
    return total if found else None


def _mean(values: Iterable[Any]) -> Decimal | None:
    items = [Decimal(str(v)) for v in values if v is not None]
    if not items:
        return None
    return quantize_ratio(sum(items) / Decimal(len(items)))


async def _rows(session: AsyncSession, user_id: uuid.UUID) -> list[Any]:
    result = await session.execute(product_stats_rows_query(user_id))
    return list(result.all())


def _top(rows: list[Any], *, key: str, limit: int, transform: Any) -> list[RankingEntry]:
    """지표가 있는 행만 내림차순 정렬해 상위 N개를 반환한다. `id` 를 tie-breaker 로 쓴다.

    동점이면 새로고침마다 순서가 바뀌지 않도록 id 로 순서를 고정한다.
    """
    candidates = [row for row in rows if getattr(row, key) is not None]
    candidates.sort(key=lambda row: (-getattr(row, key), str(row.product_id)))
    return [
        RankingEntry(
            product_id=row.product_id,
            product_name=row.product_name,
            value=transform(getattr(row, key)),
        )
        for row in candidates[:limit]
    ]


async def get_rankings(
    session: AsyncSession, *, user_id: uuid.UUID, limit: int = DEFAULT_RANKING_LIMIT
) -> Rankings:
    rows = await _rows(session, user_id)
    return Rankings(
        by_bottle_price=_top(rows, key="avg_paid_price", limit=limit, transform=_money),
        by_total_spend=_top(rows, key="paid_total", limit=limit, transform=_money),
        by_price_per_100ml=_top(rows, key="price_per_100ml", limit=limit, transform=_money),
        by_personal_rating=_top(
            rows, key="personal_rating", limit=limit, transform=lambda v: Decimal(str(v))
        ),
    )


def _top_ancestor_map(nodes: list[CategoryNode]) -> dict[uuid.UUID, CategoryNode]:
    """카테고리 id → 최상위 조상 노드. 부모 포인터를 루트까지 따라 올라간다.

    `depth` 는 컬럼으로 저장하지 않으므로(D26) `load_tree` 가 매번 계산한 값을 쓴다.
    """
    by_id = {node.id: node for node in nodes}
    mapping: dict[uuid.UUID, CategoryNode] = {}
    for node in nodes:
        top = node
        while top.parent_id is not None:
            top = by_id[top.parent_id]
        mapping[node.id] = top
    return mapping


def _aggregate_category(category_id: uuid.UUID | None, name: str, rows: list[Any]) -> CategoryStat:
    bottle_count = sum(int(row.purchased_count or 0) for row in rows)
    list_total = _sum_decimal(row.list_total for row in rows)
    list_volume = _sum_decimal(row.list_volume for row in rows)
    discount_list = _sum_decimal(row.discount_list_total for row in rows)
    discount_paid = _sum_decimal(row.discount_paid_total for row in rows)

    avg_price_per_100ml = (
        quantize_money(list_total * Decimal(100) / list_volume)
        if list_total is not None and list_volume
        else None
    )
    discount_rate = (
        quantize_ratio(Decimal(1) - discount_paid / discount_list)
        if discount_list and discount_paid is not None
        else None
    )

    return CategoryStat(
        category_id=category_id,
        name=name,
        bottle_count=bottle_count,
        total_spend=_money(list_total),
        avg_abv=_mean(row.abv for row in rows),
        avg_rating=_mean(row.personal_rating for row in rows),
        avg_price_per_100ml=avg_price_per_100ml,
        discount_rate=discount_rate,
    )


async def get_category_rollup(session: AsyncSession, *, user_id: uuid.UUID) -> list[CategoryStat]:
    """주종별 집계. 하위 카테고리는 최상위 주종으로 롤업한다.

    레거시 실측 롤업(와인 170·사케 12·전통주 120·맥주 642·양주 134)과 병수가
    대조된다(`docs/legacy-schema.md` §4.4).
    """
    rows = await _rows(session, user_id)
    nodes = await load_tree(session, user_id)
    top_of = _top_ancestor_map(nodes)

    groups: dict[uuid.UUID | None, list[Any]] = {}
    names: dict[uuid.UUID | None, str] = {}
    for row in rows:
        top = top_of.get(row.category_id) if row.category_id is not None else None
        key = top.id if top is not None else None
        groups.setdefault(key, []).append(row)
        names[key] = top.name if top is not None else UNCATEGORIZED_LABEL

    stats = [
        _aggregate_category(category_id, names[category_id], group_rows)
        for category_id, group_rows in groups.items()
    ]
    stats.sort(key=lambda stat: (-stat.bottle_count, stat.name))
    return stats


async def _vendor_count(session: AsyncSession, user_id: uuid.UUID) -> int:
    """구매 건에 실제로 쓰인 고유 구매처 수. 레거시 대조 기준값(82곳)과 비교한다."""
    result = await session.execute(
        select(func.count(func.distinct(Purchase.vendor_id)))
        .select_from(Product)
        .join(Sku, and_(Sku.product_id == Product.id, Sku.deleted_at.is_(None)))
        .join(Purchase, and_(Purchase.sku_id == Sku.id, Purchase.deleted_at.is_(None)))
        .where(
            Product.user_id == user_id,
            Product.deleted_at.is_(None),
            Purchase.vendor_id.is_not(None),
        )
    )
    return int(result.scalar_one() or 0)


async def get_summary(session: AsyncSession, *, user_id: uuid.UUID) -> StatsSummary:
    """전체 합계. `docs/legacy-schema.md` §5 대조 기준값과 1:1 대응한다.

    **평균값의 분모는 전체 병수·전체 용량이다** (가격이 있는 구매 건만이 아니다). 제품별
    지표(`avg_list_price` 등, 분모가 가격이 있는 병수)와 다른 기준이다. 실측 대조로 확정했다:
    ₩39,333(정가 평균) = 정가 총액 42,401,108 ÷ **전체** 1,078병, ₩6,015(100ml당 평균) =
    정가 총액 × 100 ÷ **전체** 704,970ml. 가격이 없는 선물 병도 "컬렉션 전체의 평균"에는
    한 병으로 들어가야 하기 때문이다.
    """
    rows = await _rows(session, user_id)
    vendor_count = await _vendor_count(session, user_id)

    list_total = _sum_decimal(row.list_total for row in rows)
    paid_total = _sum_decimal(row.paid_total for row in rows)
    discount_list = _sum_decimal(row.discount_list_total for row in rows)
    discount_paid = _sum_decimal(row.discount_paid_total for row in rows)
    purchased_count = sum(int(row.purchased_count or 0) for row in rows)
    total_volume_ml = sum(int(row.total_volume_ml or 0) for row in rows)

    avg_list_price = (
        quantize_money(list_total / Decimal(purchased_count))
        if list_total is not None and purchased_count
        else None
    )
    avg_paid_price = (
        quantize_money(paid_total / Decimal(purchased_count))
        if paid_total is not None and purchased_count
        else None
    )
    avg_price_per_100ml = (
        quantize_money(list_total * Decimal(100) / Decimal(total_volume_ml))
        if list_total is not None and total_volume_ml
        else None
    )
    discount_rate = (
        quantize_ratio(Decimal(1) - discount_paid / discount_list)
        if discount_list and discount_paid is not None
        else None
    )

    return StatsSummary(
        purchased_count=purchased_count,
        consumed_count=sum(int(row.finished or 0) for row in rows),
        in_stock_count=sum(int(row.in_stock or 0) for row in rows),
        unopened_count=sum(int(row.unopened or 0) for row in rows),
        opened_count=sum(int(row.open or 0) for row in rows),
        total_volume_ml=total_volume_ml,
        list_total=_money(list_total),
        paid_total=_money(paid_total),
        avg_list_price=avg_list_price,
        avg_paid_price=avg_paid_price,
        avg_price_per_100ml=avg_price_per_100ml,
        discount_rate=discount_rate,
        avg_personal_rating=_mean(row.personal_rating for row in rows),
        vendor_count=vendor_count,
    )


# --- 통계 v2: 피벗·시계열 (Task 20) -----------------------------------------
#
# 랭킹·주종별 집계·전체 합계(위)는 **제품 단위**로 미리 합산한 `product_stats_rows_query`
# 를 쓴다. 피벗은 구매처처럼 제품이 아니라 **구매 건**에 붙은 축으로도 묶어야 해서, 제품
# 단위로 미리 합치면 그룹을 나눌 수 없다. 그래서 `purchase_stats_rows_query`(구매 건
# 원자 행)를 따로 읽는다 — 두 조회가 갈라져 있는 건 중복이 아니라 집계 단위가 다르기
# 때문이다.


@dataclass(frozen=True, slots=True)
class PivotCell:
    row_key: str | None
    row_label: str
    column_key: str | None
    column_label: str
    value: Decimal | None
    bottle_count: int


@dataclass(frozen=True, slots=True)
class PivotFilters:
    """모두 AND 로 결합한다(`docs/architecture.md` §4.3 필터 규약과 같은 방식)."""

    category_id: uuid.UUID | None = None
    vendor_id: uuid.UUID | None = None
    purchased_on_min: date | None = None
    purchased_on_max: date | None = None


@dataclass(frozen=True, slots=True)
class TimeSeriesPoint:
    month: str
    bottle_count: int
    paid_total: Decimal | None


async def _purchase_rows(session: AsyncSession, user_id: uuid.UUID) -> list[Any]:
    result = await session.execute(purchase_stats_rows_query(user_id))
    return list(result.all())


async def _vendor_name_map(session: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, str]:
    rows = await session.execute(
        select(Vendor.id, Vendor.name).where(Vendor.user_id == user_id, Vendor.deleted_at.is_(None))
    )
    return {row[0]: row[1] for row in rows}


async def _dimension_resolver(
    session: AsyncSession, user_id: uuid.UUID, dimension: GroupDimension
) -> Callable[[Any], tuple[str | None, str]]:
    """구매 건 행 → (그룹 키, 표시 이름). 그룹 키가 `None` 이면 "미상"/"미분류" 묶음이다."""
    if dimension == "category":
        nodes = await load_tree(session, user_id)
        top_of = _top_ancestor_map(nodes)

        def resolve_category(row: Any) -> tuple[str | None, str]:
            top = top_of.get(row.category_id) if row.category_id is not None else None
            if top is None:
                return None, UNCATEGORIZED_LABEL
            return str(top.id), top.name

        return resolve_category

    if dimension == "vendor":
        vendor_names = await _vendor_name_map(session, user_id)

        def resolve_vendor(row: Any) -> tuple[str | None, str]:
            if row.vendor_id is None:
                return None, UNKNOWN_LABEL
            return str(row.vendor_id), vendor_names.get(row.vendor_id, UNKNOWN_LABEL)

        return resolve_vendor

    if dimension == "country":

        def resolve_country(row: Any) -> tuple[str | None, str]:
            if not row.country:
                return None, UNKNOWN_LABEL
            return row.country, row.country

        return resolve_country

    def resolve_vintage_decade(row: Any) -> tuple[str | None, str]:
        if row.vintage is None:
            return None, UNKNOWN_LABEL
        decade = (row.vintage // 10) * 10
        return str(decade), f"{decade}년대"

    return resolve_vintage_decade


def _compute_pivot_metric(metric: PivotMetric, rows: list[Any]) -> Decimal | None:
    if metric == "bottle_count":
        return Decimal(sum(int(row.quantity) for row in rows))
    if metric == "list_total":
        return _money(_sum_decimal(row.list_amount for row in rows))
    if metric == "paid_total":
        return _money(_sum_decimal(row.paid_amount for row in rows))
    if metric in ("avg_price_per_100ml", "value_for_money"):
        price = _weighted_price_per_100ml(rows)
        if metric == "avg_price_per_100ml":
            return price
        return value_for_money(_weighted_avg_rating(rows), price)
    if metric == "avg_rating":
        return _weighted_avg_rating(rows)
    if metric == "discount_rate":
        discount_list = _sum_decimal(row.both_priced_list_amount for row in rows)
        discount_paid = _sum_decimal(row.both_priced_paid_amount for row in rows)
        if not discount_list or discount_paid is None:
            return None
        return quantize_ratio(Decimal(1) - discount_paid / discount_list)
    raise ValueError(f"지원하지 않는 지표입니다: {metric}")


def _weighted_price_per_100ml(rows: list[Any]) -> Decimal | None:
    list_total = _sum_decimal(row.list_amount for row in rows)
    list_volume = _sum_decimal(row.list_volume for row in rows)
    if list_total is None or not list_volume:
        return None
    return quantize_money(list_total * Decimal(100) / list_volume)


def _weighted_avg_rating(rows: list[Any]) -> Decimal | None:
    """병 수량으로 가중한 평균 평점. 병 하나하나를 한 단위로 센다."""
    total = Decimal(0)
    count = 0
    for row in rows:
        if row.personal_rating is None:
            continue
        total += Decimal(str(row.personal_rating)) * int(row.quantity)
        count += int(row.quantity)
    if count == 0:
        return None
    return quantize_ratio(total / Decimal(count))


async def get_pivot(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    row_dimension: GroupDimension,
    column_dimension: GroupDimension | None,
    metric: PivotMetric,
    filters: PivotFilters | None = None,
) -> list[PivotCell]:
    """구매 건을 두 축(행·열)으로 묶어 지표 하나를 계산한다.

    행렬로 조립하지 않고 셀 목록(flat)을 그대로 반환한다 — 화면이 필요한 모양으로 다시
    묶는 편이, 여기서 결측 셀까지 채운 2차원 배열을 만드는 것보다 단순하다.
    """
    filters = filters or PivotFilters()
    rows = await _purchase_rows(session, user_id)

    if filters.category_id is not None:
        scope = set((await session.execute(descendant_ids_query(filters.category_id))).scalars())
        scope.add(filters.category_id)
        rows = [row for row in rows if row.category_id in scope]
    if filters.vendor_id is not None:
        rows = [row for row in rows if row.vendor_id == filters.vendor_id]
    if filters.purchased_on_min is not None:
        rows = [
            row
            for row in rows
            if row.purchased_on is not None and row.purchased_on >= filters.purchased_on_min
        ]
    if filters.purchased_on_max is not None:
        rows = [
            row
            for row in rows
            if row.purchased_on is not None and row.purchased_on <= filters.purchased_on_max
        ]

    resolve_row = await _dimension_resolver(session, user_id, row_dimension)
    resolve_column = (
        await _dimension_resolver(session, user_id, column_dimension)
        if column_dimension is not None
        else None
    )

    groups: dict[tuple[str | None, str | None], list[Any]] = {}
    labels: dict[tuple[str | None, str | None], tuple[str, str]] = {}
    for row in rows:
        row_key, row_label = resolve_row(row)
        column_key, column_label = resolve_column(row) if resolve_column is not None else (None, "")
        key = (row_key, column_key)
        groups.setdefault(key, []).append(row)
        labels[key] = (row_label, column_label)

    cells = [
        PivotCell(
            row_key=key[0],
            row_label=labels[key][0],
            column_key=key[1],
            column_label=labels[key][1],
            value=_compute_pivot_metric(metric, group_rows),
            bottle_count=sum(int(row.quantity) for row in group_rows),
        )
        for key, group_rows in groups.items()
    ]
    cells.sort(key=lambda cell: (cell.row_label, cell.column_label))
    return cells


async def get_timeseries(session: AsyncSession, *, user_id: uuid.UUID) -> list[TimeSeriesPoint]:
    """월별 지출·구매 병수. `purchased_on` 이 없는 구매 건은 시계열에 놓을 위치가 없어 뺀다."""
    rows = await _purchase_rows(session, user_id)

    groups: dict[str, list[Any]] = {}
    for row in rows:
        if row.purchased_on is None:
            continue
        month = row.purchased_on.strftime("%Y-%m")
        groups.setdefault(month, []).append(row)

    points = [
        TimeSeriesPoint(
            month=month,
            bottle_count=sum(int(row.quantity) for row in group_rows),
            paid_total=_money(_sum_decimal(row.paid_amount for row in group_rows)),
        )
        for month, group_rows in groups.items()
    ]
    points.sort(key=lambda point: point.month)
    return points
