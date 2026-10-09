"""파생 지표의 SQL 구현.

`domain/metrics.py` 와 **같은 공식**을 SQL 로 구현한다. 목록·통계 조회에서 제품 수백~수천
건의 지표를 한 번에 계산해야 하므로, 행마다 파이썬으로 계산하면 왕복이 과도해진다.

두 구현이 갈라지면 화면과 API 가 다른 값을 보여주게 된다.
`tests/infrastructure/database/test_metrics_parity.py`가 같은 데이터의 결과를 비교한다.
공식을 바꿀 때는 **반드시 양쪽을 함께** 고친다.
"""

import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import Numeric, Select, and_, case, cast, func, literal, select
from sqlalchemy.orm import InstrumentedAttribute
from sqlalchemy.sql.expression import ColumnElement

from sooljang.domain.metrics import ML_PER_UNIT
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Product,
    Purchase,
    Sku,
)

#: 금액 계산에 쓰는 수치 타입. Decimal 정밀도를 유지한다.
_MONEY = Numeric(20, 4)


def _priced_amount(unit_price: InstrumentedAttribute[Decimal | None]) -> ColumnElement[Any]:
    """구매 가격 공란은 0원이다. 무료 취득도 수량·용량 분모에 포함한다."""
    return cast(func.coalesce(unit_price, literal(0)), _MONEY) * cast(Purchase.quantity, _MONEY)


def _purchased_volume() -> ColumnElement[Any]:
    return cast(Sku.volume_ml, _MONEY) * cast(Purchase.quantity, _MONEY)


def product_price_metrics_query(user_id: uuid.UUID, *, by_sku: bool = False) -> Select[Any]:
    """제품별 금액 파생 지표를 한 번에 계산한다.

    `domain.metrics.compute_price_metrics` 와 같은 규칙을 따른다.

    - 구매 가격 공란은 0원이다
    - 평단가의 분모는 선물·포인트 구매를 포함한 전체 구매 병수다
    - 100ml당 가격은 가중 평균이며 **정가 기준**이다
    - 할인율은 정가가 기록된(0원 초과) 구매의 정가·실구매가 합계로 계산한다
    """
    list_amount = func.sum(_priced_amount(Purchase.unit_list_price))
    paid_amount = func.sum(_priced_amount(Purchase.unit_paid_price))
    list_quantity = func.sum(Purchase.quantity)
    paid_quantity = func.sum(Purchase.quantity)
    list_volume = func.sum(_purchased_volume())
    paid_volume = func.sum(_purchased_volume())

    list_recorded = func.coalesce(Purchase.unit_list_price, literal(0)) > 0
    discount_list = func.sum(
        case((list_recorded, _priced_amount(Purchase.unit_list_price)), else_=literal(0))
    )
    discount_paid = func.sum(
        case((list_recorded, _priced_amount(Purchase.unit_paid_price)), else_=literal(0))
    )

    return (
        select(
            Product.id.label("product_id"),
            *([Sku.id.label("sku_id")] if by_sku else []),
            func.coalesce(func.sum(Purchase.quantity), literal(0)).label("purchased_count"),
            func.coalesce(list_quantity, literal(0)).label("priced_quantity"),
            func.coalesce(paid_quantity, literal(0)).label("paid_quantity"),
            list_amount.label("list_total"),
            paid_amount.label("paid_total"),
            # NULLIF 로 0 분모를 NULL 로 바꿔 나눗셈 오류 대신 NULL 을 만든다.
            (list_amount / func.nullif(list_quantity, 0)).label("avg_list_price"),
            (paid_amount / func.nullif(paid_quantity, 0)).label("avg_paid_price"),
            (list_amount * literal(ML_PER_UNIT) / func.nullif(list_volume, 0)).label(
                "price_per_100ml"
            ),
            (paid_amount * literal(ML_PER_UNIT) / func.nullif(paid_volume, 0)).label(
                "price_per_100ml_paid"
            ),
            (literal(1) - discount_paid / func.nullif(discount_list, 0)).label("discount_rate"),
            func.coalesce(
                func.sum(cast(Sku.volume_ml, _MONEY) * cast(Purchase.quantity, _MONEY)),
                literal(0),
            ).label("total_volume_ml"),
            # 통계 대시보드의 주종별 집계가 제품 단위 가중 평균을 그룹 단위로 다시 계산할 때
            # 쓴다(`application/stats.py`). 개별 제품 지표 응답에는 노출하지 않는다.
            func.coalesce(list_volume, literal(0)).label("list_volume"),
            discount_list.label("discount_list_total"),
            discount_paid.label("discount_paid_total"),
        )
        .select_from(Product)
        .join(
            Sku,
            and_(Sku.product_id == Product.id, Sku.user_id == user_id, Sku.deleted_at.is_(None)),
        )
        .join(
            Purchase,
            and_(
                Purchase.sku_id == Sku.id,
                Purchase.user_id == user_id,
                Purchase.deleted_at.is_(None),
            ),
        )
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
        .group_by(Product.id, *([Sku.id] if by_sku else []))
    )


def _status_count(status: BottleStatus) -> ColumnElement[Any]:
    return func.count(case((Bottle.status == status, literal(1))))


def product_bottle_tally_query(user_id: uuid.UUID, *, by_sku: bool = False) -> Select[Any]:
    """제품별 상태 병수를 집계한다. `domain.metrics.tally_bottles` 와 같은 규칙이다."""
    unopened = _status_count(BottleStatus.UNOPENED)
    open_count = _status_count(BottleStatus.OPEN)

    return (
        select(
            Product.id.label("product_id"),
            *([Sku.id.label("sku_id")] if by_sku else []),
            unopened.label("unopened"),
            open_count.label("open"),
            _status_count(BottleStatus.FINISHED).label("finished"),
            _status_count(BottleStatus.GIFTED).label("gifted"),
            _status_count(BottleStatus.SOLD).label("sold"),
            (unopened + open_count).label("in_stock"),
        )
        .select_from(Product)
        .join(
            Sku,
            and_(Sku.product_id == Product.id, Sku.user_id == user_id, Sku.deleted_at.is_(None)),
        )
        .join(
            Purchase,
            and_(
                Purchase.sku_id == Sku.id,
                Purchase.user_id == user_id,
                Purchase.deleted_at.is_(None),
            ),
        )
        .join(
            Bottle,
            and_(
                Bottle.purchase_id == Purchase.id,
                Bottle.user_id == user_id,
                Bottle.deleted_at.is_(None),
            ),
        )
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
        .group_by(Product.id, *([Sku.id] if by_sku else []))
    )


def sku_metrics_query(user_id: uuid.UUID) -> Select[Any]:
    """SKU의 모든 유효 구매·병을 집계한다. 구매 없는 규격도 가격 null로 남긴다."""
    prices = product_price_metrics_query(user_id, by_sku=True).subquery("sku_prices")
    tally = product_bottle_tally_query(user_id, by_sku=True).subquery("sku_bottles")
    in_stock = func.coalesce(tally.c.in_stock, literal(0))
    # SKU별로 2자리를 확정한 뒤 상위 합계에 더한다. 표시용 평균은 재사용하지 않는다.
    inventory_value = func.round(
        prices.c.paid_total * cast(in_stock, _MONEY) / func.nullif(prices.c.purchased_count, 0), 2
    )
    return (
        select(
            Sku.product_id.label("product_id"),
            Sku.id.label("sku_id"),
            Sku.volume_ml,
            *[
                func.coalesce(prices.c[name], literal(0)).label(name)
                for name in (
                    "purchased_count",
                    "priced_quantity",
                    "paid_quantity",
                    "total_volume_ml",
                    "list_volume",
                )
            ],
            *[
                prices.c[name]
                for name in (
                    "list_total",
                    "paid_total",
                    "avg_list_price",
                    "avg_paid_price",
                    "price_per_100ml",
                    "price_per_100ml_paid",
                    "discount_rate",
                    "discount_list_total",
                    "discount_paid_total",
                )
            ],
            *[
                func.coalesce(tally.c[name], literal(0)).label(name)
                for name in ("unopened", "open", "finished", "gifted", "sold", "in_stock")
            ],
            inventory_value.label("inventory_value_at_cost"),
        )
        .select_from(Sku)
        .join(
            Product,
            and_(
                Product.id == Sku.product_id,
                Product.user_id == user_id,
                Product.deleted_at.is_(None),
            ),
        )
        .outerjoin(prices, prices.c.sku_id == Sku.id)
        .outerjoin(tally, tally.c.sku_id == Sku.id)
        .where(Sku.user_id == user_id, Sku.deleted_at.is_(None))
    )


def product_metrics_query(user_id: uuid.UUID) -> Select[Any]:
    """SKU별 확정 원가를 합산한다. 제품 평균은 원본 금액·수량으로 계산한다."""
    skus = sku_metrics_query(user_id).subquery("sku_metrics")
    quantity = func.sum(skus.c.purchased_count)
    volume = func.sum(skus.c.total_volume_ml)
    list_amount = func.sum(skus.c.list_total)
    paid_amount = func.sum(skus.c.paid_total)
    discount_list = func.sum(skus.c.discount_list_total)
    discount_paid = func.sum(skus.c.discount_paid_total)
    return select(
        skus.c.product_id,
        *[
            func.sum(skus.c[name]).label(name)
            for name in (
                "purchased_count",
                "priced_quantity",
                "paid_quantity",
                "list_total",
                "paid_total",
                "total_volume_ml",
                "list_volume",
                "discount_list_total",
                "discount_paid_total",
                "unopened",
                "open",
                "finished",
                "gifted",
                "sold",
                "in_stock",
                "inventory_value_at_cost",
            )
        ],
        (list_amount / func.nullif(quantity, 0)).label("avg_list_price"),
        (paid_amount / func.nullif(quantity, 0)).label("avg_paid_price"),
        (list_amount * literal(ML_PER_UNIT) / func.nullif(volume, 0)).label("price_per_100ml"),
        (paid_amount * literal(ML_PER_UNIT) / func.nullif(volume, 0)).label("price_per_100ml_paid"),
        (literal(1) - discount_paid / func.nullif(discount_list, 0)).label("discount_rate"),
    ).group_by(skus.c.product_id)


def single_product_metrics_query(user_id: uuid.UUID, product_id: uuid.UUID) -> Select[Any]:
    """제품 한 건의 지표. 상세 화면에서 쓴다."""
    metrics = product_metrics_query(user_id).subquery("all_metrics")
    return select(metrics).where(metrics.c.product_id == product_id)


def purchase_stats_rows_query(user_id: uuid.UUID) -> Select[Any]:
    """구매 건 단위 원자 행. 통계 v2(Task 20) 피벗·시계열이 파이썬에서 자유롭게 그룹핑할
    재료다.

    `product_stats_rows_query` 처럼 제품 단위로 미리 합산하지 않는다 — 피벗의 그룹 축
    (구매처 등)이 제품이 아니라 구매 건에 붙어 있어서, 제품 단위로 먼저 합치면 그룹을
    나눌 수 없다(한 제품을 서로 다른 구매처에서 샀을 수 있다).
    """
    list_amount = _priced_amount(Purchase.unit_list_price)
    paid_amount = _priced_amount(Purchase.unit_paid_price)
    list_volume = _purchased_volume()

    return (
        select(
            Purchase.id.label("purchase_id"),
            Product.category_id.label("category_id"),
            Purchase.vendor_id.label("vendor_id"),
            Product.country.label("country"),
            Product.vintage.label("vintage"),
            Product.personal_rating.label("personal_rating"),
            Purchase.purchased_on.label("purchased_on"),
            Purchase.quantity.label("quantity"),
            list_amount.label("list_amount"),
            paid_amount.label("paid_amount"),
            list_volume.label("list_volume"),
            # 할인율 재료 — 정가가 기록된 구매만(`domain.metrics._discount_rate`).
            case(
                (func.coalesce(Purchase.unit_list_price, literal(0)) > 0, list_amount),
                else_=literal(0),
            ).label("both_priced_list_amount"),
            case(
                (func.coalesce(Purchase.unit_list_price, literal(0)) > 0, paid_amount),
                else_=literal(0),
            ).label("both_priced_paid_amount"),
        )
        .select_from(Product)
        .join(
            Sku,
            and_(Sku.product_id == Product.id, Sku.user_id == user_id, Sku.deleted_at.is_(None)),
        )
        .join(
            Purchase,
            and_(
                Purchase.sku_id == Sku.id,
                Purchase.user_id == user_id,
                Purchase.deleted_at.is_(None),
            ),
        )
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
    )


def product_stats_rows_query(user_id: uuid.UUID) -> Select[Any]:
    """통계 대시보드(랭킹·주종별 집계·전체 합계)용 제품별 지표 + 분류 정보.

    `application/stats.py` 가 이 한 쿼리의 결과를 랭킹 정렬과 주종별 그룹핑 양쪽에
    재사용한다. 제품 규모가 수백 건이라 파이썬에서 집계해도 된다(§ Task 14 결정).
    구매 건이 없는 제품도 남기려면 지표를 LEFT JOIN 해야 한다 — 등록만 하고 아직
    구매 기록이 없는 제품이 사라지면 안 된다.
    """
    metrics = product_metrics_query(user_id).subquery("stats_metrics")
    return (
        select(
            Product.id.label("product_id"),
            Product.name.label("product_name"),
            Product.category_id.label("category_id"),
            Product.abv.label("abv"),
            Product.personal_rating.label("personal_rating"),
            metrics.c.purchased_count,
            metrics.c.priced_quantity,
            metrics.c.paid_quantity,
            metrics.c.list_total,
            metrics.c.paid_total,
            metrics.c.avg_list_price,
            metrics.c.avg_paid_price,
            metrics.c.price_per_100ml,
            metrics.c.price_per_100ml_paid,
            metrics.c.discount_rate,
            metrics.c.total_volume_ml,
            metrics.c.list_volume,
            metrics.c.discount_list_total,
            metrics.c.discount_paid_total,
            metrics.c.unopened,
            metrics.c.open,
            metrics.c.finished,
            metrics.c.gifted,
            metrics.c.sold,
            metrics.c.in_stock,
            metrics.c.inventory_value_at_cost,
        )
        .select_from(Product)
        .outerjoin(metrics, metrics.c.product_id == Product.id)
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
    )
