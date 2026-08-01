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
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.categories import CategoryNode, load_tree
from sooljang.domain.metrics import quantize_money, quantize_ratio
from sooljang.infrastructure.database.metrics_sql import product_stats_rows_query
from sooljang.infrastructure.database.models import Product, Purchase, Sku

#: 랭킹 하나당 기본 상위 건수.
DEFAULT_RANKING_LIMIT = 10
#: 주종이 없는 제품(카테고리 미지정)을 묶는 이름.
UNCATEGORIZED_LABEL = "미분류"


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
