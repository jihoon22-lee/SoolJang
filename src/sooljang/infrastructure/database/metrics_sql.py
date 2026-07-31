"""파생 지표의 SQL 구현.

`domain/metrics.py` 와 **같은 공식**을 SQL 로 구현한다. 목록·통계 조회에서 제품 수백~수천
건의 지표를 한 번에 계산해야 하므로, 행마다 파이썬으로 계산하면 왕복이 과도해진다.

두 구현이 갈라지면 화면과 API 가 다른 값을 보여주게 된다. `tests/domain/test_metrics_parity.py`
가 같은 데이터에 대해 두 결과가 일치하는지 검증한다. 공식을 바꿀 때는 **반드시 양쪽을 함께**
고친다.
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
    """단가가 있는 구매 건만 금액으로 환산한다. 없으면 NULL 이라 SUM 에서 빠진다."""
    return cast(unit_price, _MONEY) * cast(Purchase.quantity, _MONEY)


def _priced_quantity(unit_price: InstrumentedAttribute[Decimal | None]) -> ColumnElement[Any]:
    """단가가 있는 구매 건의 병수만 센다. 평단가의 분모가 되어야 한다."""
    return case((unit_price.is_(None), literal(0)), else_=Purchase.quantity)


def _priced_volume(unit_price: InstrumentedAttribute[Decimal | None]) -> ColumnElement[Any]:
    """단가가 있는 구매 건의 총 용량만 센다. 100ml당 가격의 분모가 되어야 한다."""
    return case(
        (unit_price.is_(None), literal(0)),
        else_=cast(Sku.volume_ml, _MONEY) * cast(Purchase.quantity, _MONEY),
    )


def _both_priced() -> ColumnElement[bool]:
    """정가와 실구매가가 모두 있는 구매 건. 할인율의 모집단이다."""
    return and_(
        Purchase.unit_list_price.is_not(None),
        Purchase.unit_paid_price.is_not(None),
    )


def product_price_metrics_query(user_id: uuid.UUID) -> Select[Any]:
    """제품별 금액 파생 지표를 한 번에 계산한다.

    `domain.metrics.compute_price_metrics` 와 같은 규칙을 따른다.

    - 가격이 없는 구매 건은 금액 집계에서 빠지고 병수 집계에는 남는다
    - 평단가의 분모는 **가격이 있는 구매 건의 병수**다
    - 100ml당 가격은 가중 평균이며 **정가 기준**이다
    - 할인율은 정가와 실구매가가 모두 있는 구매 건만으로 계산한다
    """
    list_amount = func.sum(_priced_amount(Purchase.unit_list_price))
    paid_amount = func.sum(_priced_amount(Purchase.unit_paid_price))
    list_quantity = func.sum(_priced_quantity(Purchase.unit_list_price))
    paid_quantity = func.sum(_priced_quantity(Purchase.unit_paid_price))
    list_volume = func.sum(_priced_volume(Purchase.unit_list_price))
    paid_volume = func.sum(_priced_volume(Purchase.unit_paid_price))

    discount_list = func.sum(
        case((_both_priced(), _priced_amount(Purchase.unit_list_price)), else_=literal(0))
    )
    discount_paid = func.sum(
        case((_both_priced(), _priced_amount(Purchase.unit_paid_price)), else_=literal(0))
    )

    return (
        select(
            Product.id.label("product_id"),
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
        )
        .select_from(Product)
        .join(Sku, and_(Sku.product_id == Product.id, Sku.deleted_at.is_(None)))
        .join(Purchase, and_(Purchase.sku_id == Sku.id, Purchase.deleted_at.is_(None)))
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
        .group_by(Product.id)
    )


def _status_count(status: BottleStatus) -> ColumnElement[Any]:
    return func.count(case((Bottle.status == status, literal(1))))


def product_bottle_tally_query(user_id: uuid.UUID) -> Select[Any]:
    """제품별 상태 병수를 집계한다. `domain.metrics.tally_bottles` 와 같은 규칙이다."""
    unopened = _status_count(BottleStatus.UNOPENED)
    open_count = _status_count(BottleStatus.OPEN)

    return (
        select(
            Product.id.label("product_id"),
            unopened.label("unopened"),
            open_count.label("open"),
            _status_count(BottleStatus.FINISHED).label("finished"),
            _status_count(BottleStatus.GIFTED).label("gifted"),
            _status_count(BottleStatus.SOLD).label("sold"),
            (unopened + open_count).label("in_stock"),
        )
        .select_from(Product)
        .join(Sku, and_(Sku.product_id == Product.id, Sku.deleted_at.is_(None)))
        .join(Purchase, and_(Purchase.sku_id == Sku.id, Purchase.deleted_at.is_(None)))
        .join(Bottle, and_(Bottle.purchase_id == Purchase.id, Bottle.deleted_at.is_(None)))
        .where(Product.user_id == user_id, Product.deleted_at.is_(None))
        .group_by(Product.id)
    )


def product_metrics_query(user_id: uuid.UUID) -> Select[Any]:
    """금액과 병수 지표를 합쳐 제품별 한 행으로 만든다.

    병 레코드가 없는 제품도 남기려면 병수 집계를 LEFT JOIN 해야 한다. 임포트 직후처럼
    구매 건만 있고 병이 아직 없는 상태에서도 금액 지표는 보여야 한다.
    """
    prices = product_price_metrics_query(user_id).subquery("price_metrics")
    tally = product_bottle_tally_query(user_id).subquery("bottle_tally")

    inventory_value = prices.c.avg_paid_price * cast(
        func.coalesce(tally.c.in_stock, literal(0)), _MONEY
    )

    return (
        select(
            prices.c.product_id,
            prices.c.purchased_count,
            prices.c.priced_quantity,
            prices.c.paid_quantity,
            prices.c.list_total,
            prices.c.paid_total,
            prices.c.avg_list_price,
            prices.c.avg_paid_price,
            prices.c.price_per_100ml,
            prices.c.price_per_100ml_paid,
            prices.c.discount_rate,
            prices.c.total_volume_ml,
            func.coalesce(tally.c.unopened, literal(0)).label("unopened"),
            func.coalesce(tally.c.open, literal(0)).label("open"),
            func.coalesce(tally.c.finished, literal(0)).label("finished"),
            func.coalesce(tally.c.gifted, literal(0)).label("gifted"),
            func.coalesce(tally.c.sold, literal(0)).label("sold"),
            func.coalesce(tally.c.in_stock, literal(0)).label("in_stock"),
            inventory_value.label("inventory_value_at_cost"),
        )
        .select_from(prices)
        .outerjoin(tally, tally.c.product_id == prices.c.product_id)
    )


def single_product_metrics_query(user_id: uuid.UUID, product_id: uuid.UUID) -> Select[Any]:
    """제품 한 건의 지표. 상세 화면에서 쓴다."""
    metrics = product_metrics_query(user_id).subquery("all_metrics")
    return select(metrics).where(metrics.c.product_id == product_id)
