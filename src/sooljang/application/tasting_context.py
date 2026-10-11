"""시음과 정정 화면에 필요한 소유권 검사 및 조회 맥락."""

import datetime
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import raiseload

from sooljang.api.errors import NotFoundError
from sooljang.application.tastings import (
    _live_tasting_conditions,
    live_bottles_query,
    tasting_conditions,
)
from sooljang.infrastructure.database.models import (
    Bottle,
    Product,
    Purchase,
    Sku,
    TastingSession,
    Vendor,
)


def columns(record: Any) -> dict[str, Any]:
    return {column.key: getattr(record, column.key) for column in record.__table__.columns}


def product_context(sku: Sku, product: Product) -> dict[str, Any]:
    return dict(
        product_id=product.id,
        product_name=product.name,
        vintage=product.vintage,
        age_years=None if product.age_years is None else str(product.age_years),
        abv=None if product.abv is None else str(product.abv),
        sku_id=sku.id,
        volume_ml=sku.volume_ml,
    )


async def purchase_context(session: AsyncSession, purchase: Purchase) -> dict[str, Any]:
    vendor = (
        await session.scalar(
            select(Vendor).where(
                Vendor.id == purchase.vendor_id, Vendor.user_id == purchase.user_id
            )
        )
        if purchase.vendor_id
        else None
    )
    return {**columns(purchase), "vendor_name": vendor.name if vendor else None}


async def owned_tasting(
    session: AsyncSession, user_id: uuid.UUID, tasting_id: uuid.UUID
) -> TastingSession:
    row = await session.scalar(
        select(TastingSession).where(
            *_live_tasting_conditions(user_id), TastingSession.id == tasting_id
        )
    )
    if row is None:
        raise NotFoundError("시음 기록을 찾을 수 없습니다")
    return row


async def contextual_tastings(
    session: AsyncSession,
    user_id: uuid.UUID,
    records: list[TastingSession],
    *,
    product_id: uuid.UUID | None = None,
    sku_id: uuid.UUID | None = None,
    bottle_id: uuid.UUID | None = None,
    tasted_on_min: datetime.date | None = None,
    tasted_on_max: datetime.date | None = None,
) -> list[dict[str, Any]]:
    if not records:
        return []
    # 초기 목록 뒤에 삭제·연결 정정이 커밋될 수 있으므로 시음과 모든 맥락을
    # 한 SQL snapshot으로 다시 읽는다. ORM identity map의 이전 연결도 갱신한다.
    rows = (
        await session.execute(
            select(TastingSession, Sku, Product, Bottle, Purchase, Vendor.name)
            .select_from(TastingSession)
            .join(Sku, Sku.id == TastingSession.sku_id)
            .join(Product, Product.id == Sku.product_id)
            .outerjoin(Bottle, Bottle.id == TastingSession.bottle_id)
            .outerjoin(Purchase, Purchase.id == Bottle.purchase_id)
            .outerjoin(Vendor, (Vendor.id == Purchase.vendor_id) & (Vendor.user_id == user_id))
            .where(
                TastingSession.id.in_([record.id for record in records]),
                *tasting_conditions(
                    user_id,
                    product_id=product_id,
                    sku_id=sku_id,
                    bottle_id=bottle_id,
                    tasted_on_min=tasted_on_min,
                    tasted_on_max=tasted_on_max,
                ),
            )
            .options(raiseload("*"))
            .execution_options(populate_existing=True)
        )
    ).tuples()
    snapshots = {
        record.id: {
            **columns(record),
            "context": product_context(sku, product),
            "bottle": columns(bottle) if bottle is not None else None,
            "purchase": {**columns(purchase), "vendor_name": vendor_name}
            if purchase is not None
            else None,
        }
        for record, sku, product, bottle, purchase, vendor_name in rows
    }
    # 페이지 cursor는 최초 목록의 마지막 행으로 진행한다. 중간에 사라진 행만 빼고
    # 그 목록의 순서를 유지하므로 빈 페이지여도 다음 cursor로 이어 받을 수 있다.
    return [snapshots[record.id] for record in records if record.id in snapshots]


async def bottle_context(
    session: AsyncSession, user_id: uuid.UUID, bottle_id: uuid.UUID
) -> dict[str, Any]:
    bottle = await session.scalar(live_bottles_query(user_id).where(Bottle.id == bottle_id))
    if bottle is None:
        raise NotFoundError("병을 찾을 수 없습니다")
    purchase = await session.get(Purchase, bottle.purchase_id)
    assert purchase is not None
    sku = await session.get(Sku, purchase.sku_id)
    assert sku is not None
    product = await session.get(Product, sku.product_id)
    assert product is not None
    return dict(
        context=product_context(sku, product),
        purchase=await purchase_context(session, purchase),
        bottle=columns(bottle),
    )


async def correction_purchase_context(
    session: AsyncSession, user_id: uuid.UUID, purchase_id: uuid.UUID
) -> dict[str, Any]:
    row = (
        await session.execute(
            select(Purchase, Sku, Product)
            .join(Sku, Sku.id == Purchase.sku_id)
            .join(Product, Product.id == Sku.product_id)
            .where(
                Purchase.id == purchase_id,
                Purchase.user_id == user_id,
                Purchase.deleted_at.is_(None),
                Sku.user_id == user_id,
                Sku.deleted_at.is_(None),
                Product.user_id == user_id,
                Product.deleted_at.is_(None),
            )
        )
    ).one_or_none()
    if row is None:
        raise NotFoundError("구매 건을 찾을 수 없습니다")
    purchase, sku, product = row
    bottles = list(
        await session.scalars(
            select(Bottle)
            .where(Bottle.purchase_id == purchase_id, Bottle.user_id == user_id)
            .order_by(Bottle.id)
        )
    )
    tastings = list(
        await session.scalars(
            select(TastingSession)
            .where(
                TastingSession.bottle_id.in_([b.id for b in bottles]),
                TastingSession.user_id == user_id,
            )
            .order_by(TastingSession.id)
        )
    )
    data = await purchase_context(session, purchase)
    data.update(
        volume_ml=sku.volume_ml,
        bottle_count=sum(b.deleted_at is None for b in bottles),
        list_total=None
        if purchase.unit_list_price is None
        else purchase.unit_list_price * purchase.quantity,
        paid_total=None
        if purchase.unit_paid_price is None
        else purchase.unit_paid_price * purchase.quantity,
    )
    return dict(
        purchase=data,
        context=product_context(sku, product),
        bottles=[columns(b) for b in bottles],
        tastings=[columns(t) for t in tastings],
    )
