"""검색 가격의 구매 모집단 M. 제품 전체 지표·SKU 원가와 분리해 계산한다."""

import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import Select, and_, func, literal, select

from sooljang.domain.metrics import ML_PER_UNIT
from sooljang.infrastructure.database.metrics_sql import (
    product_bottle_tally_query,
    product_price_metrics_query,
)
from sooljang.infrastructure.database.models import Product, Purchase, Sku

PRICE_FIELDS = (
    "purchased_count",
    "total_volume_ml",
    "list_total",
    "paid_total",
    "avg_list_price",
    "avg_paid_price",
    "price_per_100ml",
    "price_per_100ml_paid",
    "discount_rate",
)


@dataclass(frozen=True, slots=True)
class PurchaseScope:
    volume_ml: int | None = None
    vendor_id: uuid.UUID | None = None
    purchased_on_min: date | None = None
    purchased_on_max: date | None = None
    in_stock: bool | None = None

    @property
    def requires_purchase(self) -> bool:
        return any(
            value is not None
            for value in (self.vendor_id, self.purchased_on_min, self.purchased_on_max)
        )

    @property
    def active(self) -> bool:
        return self.requires_purchase or self.volume_ml is not None or self.in_stock is not None


def matching_price_metrics_query(user_id: uuid.UUID, scope: PurchaseScope) -> Select[Any]:
    """같은 구매 건에 조건을 결합하고 재고는 그 구매가 속한 SKU를 한정한다."""
    conditions = []
    if scope.volume_ml is not None:
        conditions.append(Sku.volume_ml == scope.volume_ml)
    if scope.vendor_id is not None:
        conditions.append(Purchase.vendor_id == scope.vendor_id)
    if scope.purchased_on_min is not None:
        conditions.append(Purchase.purchased_on >= scope.purchased_on_min)
    if scope.purchased_on_max is not None:
        conditions.append(Purchase.purchased_on <= scope.purchased_on_max)
    prices = (
        product_price_metrics_query(user_id, by_sku=True)
        .where(*conditions)
        .subquery("matching_sku_prices")
    )
    stock = (
        product_bottle_tally_query(user_id, by_sku=True)
        .where(*conditions)
        .subquery("matching_sku_stock")
    )
    eligible = (
        select(
            Sku.product_id.label("product_id"),
            *[
                func.coalesce(prices.c[name], literal(0)).label(name)
                for name in ("purchased_count", "total_volume_ml")
            ],
            *[
                prices.c[name]
                for name in (
                    "list_total",
                    "paid_total",
                    "discount_list_total",
                    "discount_paid_total",
                )
            ],
            func.coalesce(stock.c.in_stock, literal(0)).label("in_stock"),
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
        .outerjoin(stock, stock.c.sku_id == Sku.id)
        .where(Sku.user_id == user_id, Sku.deleted_at.is_(None))
    )
    if scope.volume_ml is not None:
        eligible = eligible.where(Sku.volume_ml == scope.volume_ml)
    if scope.requires_purchase:
        eligible = eligible.where(prices.c.purchased_count > 0)
    if scope.in_stock is True:
        # 남은 병이 있는 SKU의 과거 조건 일치 구매도 prices에 그대로 포함한다.
        eligible = eligible.where(stock.c.in_stock > 0)
    skus = eligible.subquery("matching_skus")
    quantity = func.sum(skus.c.purchased_count)
    volume = func.sum(skus.c.total_volume_ml)
    list_total = func.sum(skus.c.list_total)
    paid_total = func.sum(skus.c.paid_total)
    return select(
        skus.c.product_id,
        quantity.label("purchased_count"),
        volume.label("total_volume_ml"),
        list_total.label("list_total"),
        paid_total.label("paid_total"),
        (list_total / func.nullif(quantity, 0)).label("avg_list_price"),
        (paid_total / func.nullif(quantity, 0)).label("avg_paid_price"),
        (list_total * literal(ML_PER_UNIT) / func.nullif(volume, 0)).label("price_per_100ml"),
        (paid_total * literal(ML_PER_UNIT) / func.nullif(volume, 0)).label("price_per_100ml_paid"),
        (
            literal(1)
            - func.sum(skus.c.discount_paid_total)
            / func.nullif(func.sum(skus.c.discount_list_total), 0)
        ).label("discount_rate"),
        func.sum(skus.c.in_stock).label("in_stock"),
    ).group_by(skus.c.product_id)
