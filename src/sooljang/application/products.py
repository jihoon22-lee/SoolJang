"""제품 조회·필터·검색.

필터는 모두 AND 로 결합한다(`docs/architecture.md` §4.3). 주종 필터는 **하위를 포함**하므로
재귀 CTE 로 후손 집합을 구해 `IN` 조건으로 넣는다.

정렬 대상 중 `price_per_100ml` 처럼 파생 지표인 것이 있어, 지표 서브쿼리를 조인한 뒤
정렬한다. 파생값을 저장하지 않기로 했으므로(§9.5) 정렬을 위해 저장하는 예외를 두지 않는다.
"""

import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from sooljang.api.errors import NotFoundError
from sooljang.application.categories import descendant_ids_query, load_tree
from sooljang.domain.metrics import quantize_money, quantize_ratio
from sooljang.infrastructure.database.metrics_sql import product_metrics_query
from sooljang.infrastructure.database.models import (
    Category,
    Producer,
    Product,
    ProductVariety,
    Purchase,
    Sku,
    Variety,
)
from sooljang.infrastructure.legacy.normalize import normalize_name_for_matching
from sooljang.infrastructure.legacy.varieties import normalize_varieties

#: 정렬 가능한 키. 파생 지표는 지표 서브쿼리 컬럼을 가리킨다.
SortKey = Literal[
    "name",
    "created_at",
    "updated_at",
    "abv",
    "vintage",
    "personal_rating",
    "avg_list_price",
    "avg_paid_price",
    "price_per_100ml",
    "paid_total",
    "in_stock_count",
    "purchased_count",
]

_PRODUCT_SORT_COLUMNS = {
    "name": Product.name,
    "created_at": Product.created_at,
    "updated_at": Product.updated_at,
    "abv": Product.abv,
    "vintage": Product.vintage,
    "personal_rating": Product.personal_rating,
}

_METRIC_SORT_KEYS = {
    "avg_list_price": "avg_list_price",
    "avg_paid_price": "avg_paid_price",
    "price_per_100ml": "price_per_100ml",
    "paid_total": "paid_total",
    "in_stock_count": "in_stock",
    "purchased_count": "purchased_count",
}


@dataclass(frozen=True, slots=True)
class ProductFilters:
    """제품 목록 필터. 모두 AND 로 결합한다."""

    q: str | None = None
    category_id: uuid.UUID | None = None
    include_descendants: bool = True
    country: str | None = None
    abv_min: Decimal | None = None
    abv_max: Decimal | None = None
    vintage_min: int | None = None
    vintage_max: int | None = None
    rating_min: Decimal | None = None
    in_stock: bool | None = None
    vendor_id: uuid.UUID | None = None
    variety: str | None = None
    price_per_100ml_min: Decimal | None = None
    price_per_100ml_max: Decimal | None = None


async def _category_scope(
    session: AsyncSession, category_id: uuid.UUID, include_descendants: bool
) -> list[uuid.UUID]:
    """주종 필터 대상 id 집합. "위스키" 가 하위 전부를 포함해야 한다."""
    if not include_descendants:
        return [category_id]
    rows = await session.execute(descendant_ids_query(category_id))
    ids = list(rows.scalars().all())
    return ids or [category_id]


async def build_product_query(
    session: AsyncSession, *, user_id: uuid.UUID, filters: ProductFilters
) -> tuple[Select[Any], Any]:
    """필터가 적용된 제품 조회문과 지표 서브쿼리를 반환한다.

    지표 서브쿼리를 LEFT JOIN 하는 이유는 구매 건이 없는 제품도 목록에 남아야 하기
    때문이다. 등록만 하고 아직 구매 기록을 넣지 않은 술이 사라지면 사용자는 데이터가
    없어진 것으로 오해한다.
    """
    metrics = product_metrics_query(user_id).subquery("metrics")

    statement = (
        select(Product, metrics)
        .outerjoin(metrics, metrics.c.product_id == Product.id)
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
    )

    if filters.q:
        # pg_trgm GIN 인덱스가 ILIKE '%...%' 를 가속한다. 한글에서 동작함을 실측했다.
        pattern = f"%{filters.q.strip()}%"
        statement = statement.where(
            or_(Product.name.ilike(pattern), Product.name_en.ilike(pattern))
        )

    if filters.category_id is not None:
        scope = await _category_scope(session, filters.category_id, filters.include_descendants)
        statement = statement.where(Product.category_id.in_(scope))

    if filters.country:
        statement = statement.where(Product.country == filters.country)
    if filters.abv_min is not None:
        statement = statement.where(Product.abv >= filters.abv_min)
    if filters.abv_max is not None:
        statement = statement.where(Product.abv <= filters.abv_max)
    if filters.vintage_min is not None:
        statement = statement.where(Product.vintage >= filters.vintage_min)
    if filters.vintage_max is not None:
        statement = statement.where(Product.vintage <= filters.vintage_max)
    if filters.rating_min is not None:
        statement = statement.where(Product.personal_rating >= filters.rating_min)

    if filters.in_stock is True:
        statement = statement.where(func.coalesce(metrics.c.in_stock, 0) > 0)
    elif filters.in_stock is False:
        statement = statement.where(func.coalesce(metrics.c.in_stock, 0) == 0)

    if filters.price_per_100ml_min is not None:
        statement = statement.where(metrics.c.price_per_100ml >= filters.price_per_100ml_min)
    if filters.price_per_100ml_max is not None:
        statement = statement.where(metrics.c.price_per_100ml <= filters.price_per_100ml_max)

    if filters.variety:
        statement = statement.where(
            Product.id.in_(
                select(ProductVariety.product_id)
                .join(Variety, Variety.id == ProductVariety.variety_id)
                .where(Variety.name.ilike(f"%{filters.variety.strip()}%"))
            )
        )

    if filters.vendor_id is not None:
        statement = statement.where(
            Product.id.in_(
                select(Sku.product_id)
                .join(Purchase, Purchase.sku_id == Sku.id)
                .where(
                    Purchase.vendor_id == filters.vendor_id,
                    Purchase.deleted_at.is_(None),
                )
            )
        )

    statement = statement.options(
        selectinload(Product.skus),
        selectinload(Product.varieties).selectinload(ProductVariety.variety),
    )
    return statement, metrics


def sort_column_for(key: SortKey, metrics: Any) -> Any:
    """정렬 키에 해당하는 컬럼. 파생 지표는 지표 서브쿼리에서 가져온다."""
    if key in _PRODUCT_SORT_COLUMNS:
        return _PRODUCT_SORT_COLUMNS[key]
    return metrics.c[_METRIC_SORT_KEYS[key]]


async def load_product(
    session: AsyncSession, *, user_id: uuid.UUID, product_id: uuid.UUID
) -> Product:
    """제품 하나를 규격·품종과 함께 읽는다. 없으면 404 로 알린다."""
    product = await session.scalar(
        select(Product)
        .where(
            Product.id == product_id,
            Product.user_id == user_id,
            Product.deleted_at.is_(None),
        )
        .options(
            selectinload(Product.skus),
            selectinload(Product.varieties).selectinload(ProductVariety.variety),
        )
    )
    if product is None:
        raise NotFoundError(f"제품을 찾을 수 없습니다: {product_id}")
    return product


async def load_sku(session: AsyncSession, *, user_id: uuid.UUID, sku_id: uuid.UUID) -> Sku:
    """규격 하나를 읽는다. 없으면 404 로 알린다."""
    sku = await session.scalar(
        select(Sku).where(
            Sku.id == sku_id,
            Sku.user_id == user_id,
            Sku.deleted_at.is_(None),
        )
    )
    if sku is None:
        raise NotFoundError(f"규격을 찾을 수 없습니다: {sku_id}")
    return sku


async def category_path_map(
    session: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, list[str]]:
    """카테고리 id → 이름 경로. 목록 응답에 계층을 실어 주기 위해 쓴다."""
    nodes = await load_tree(session, user_id)
    return {node.id: list(node.path) for node in nodes}


async def producer_name_map(session: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, str]:
    rows = await session.execute(
        select(Producer.id, Producer.name).where(
            Producer.user_id == user_id, Producer.deleted_at.is_(None)
        )
    )
    return {row[0]: row[1] for row in rows}


async def resolve_variety_ids(
    session: AsyncSession, *, user_id: uuid.UUID, names: list[str]
) -> list[uuid.UUID]:
    """품종 이름을 id 로 바꾼다. 없으면 만든다.

    사용자가 자유롭게 품종을 적을 수 있어야 한다. 미리 등록된 목록만 허용하면 새 술을
    등록할 때마다 막힌다.
    """
    resolved: list[uuid.UUID] = []
    for item in normalize_varieties(names):
        existing = await session.scalar(
            select(Variety).where(
                Variety.user_id == user_id,
                Variety.name == item.name,
                Variety.deleted_at.is_(None),
            )
        )
        if existing is None:
            existing = Variety(user_id=user_id, name=item.name)
            session.add(existing)
            await session.flush()
        resolved.append(existing.id)
    return resolved


async def ensure_category_exists(
    session: AsyncSession, *, user_id: uuid.UUID, category_id: uuid.UUID | None
) -> None:
    if category_id is None:
        return
    found = await session.scalar(
        select(Category.id).where(
            Category.id == category_id,
            Category.user_id == user_id,
            Category.deleted_at.is_(None),
        )
    )
    if found is None:
        raise NotFoundError(f"카테고리를 찾을 수 없습니다: {category_id}")


def metrics_from_row(row: Any) -> dict[str, Any]:
    """지표 서브쿼리 행을 응답 스키마 필드로 옮긴다.

    LEFT JOIN 이라 구매 건이 없는 제품은 모든 값이 NULL 이다. 병수는 0 으로, 금액은
    None 으로 둔다. 금액 0 과 "가격 정보 없음" 은 다른 의미다(§5-D35).

    금액은 소수 둘째 자리로 정규화한다. SQL 은 `Numeric(20,4)` 로 계산해 나눗셈 결과가
    `12857.142857142857900000` 처럼 길게 나오는데, 그대로 내보내면 화면에서 잘라야 하고
    순수 함수 구현(`domain/metrics.py`)의 출력과도 형식이 달라진다.
    """
    if row is None or getattr(row, "product_id", None) is None:
        return {}
    return {
        "purchased_count": int(row.purchased_count or 0),
        "consumed_count": int(row.finished or 0),
        "in_stock_count": int(row.in_stock or 0),
        "unopened_count": int(row.unopened or 0),
        "opened_count": int(row.open or 0),
        "gifted_count": int(row.gifted or 0),
        "sold_count": int(row.sold or 0),
        "avg_list_price": _money(row.avg_list_price),
        "avg_paid_price": _money(row.avg_paid_price),
        "price_per_100ml": _money(row.price_per_100ml),
        "price_per_100ml_paid": _money(row.price_per_100ml_paid),
        "list_total": _money(row.list_total),
        "paid_total": _money(row.paid_total),
        "discount_rate": _ratio(row.discount_rate),
        "total_volume_ml": int(row.total_volume_ml or 0),
        "inventory_value_at_cost": _money(row.inventory_value_at_cost),
    }


def _money(value: Any) -> Decimal | None:
    """금액을 도메인 계층과 같은 정밀도로 맞춘다."""
    return None if value is None else quantize_money(Decimal(str(value)))


def _ratio(value: Any) -> Decimal | None:
    """비율(할인율)을 도메인 계층과 같은 정밀도로 맞춘다."""
    return None if value is None else quantize_ratio(Decimal(str(value)))


def normalized_name_of(name: str) -> str:
    """제품 중복 판정용 정규화 키."""
    return normalize_name_for_matching(name)
