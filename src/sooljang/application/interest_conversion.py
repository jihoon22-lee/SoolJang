"""관심 ID를 유지하는 원자적·멱등 구매 전환."""

import datetime
import hashlib
import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError
from sooljang.application.collection_inventory import owned
from sooljang.application.products import normalized_name_of, resolve_producer_id
from sooljang.infrastructure.database.models import (
    Bottle,
    Category,
    Interest,
    InterestConversion,
    Product,
    Purchase,
    Sku,
    Vendor,
)


async def convert_interest(
    session: AsyncSession,
    user_id: uuid.UUID,
    interest_id: uuid.UUID,
    *,
    expected_updated_at: datetime.datetime,
    sku_id: uuid.UUID | None,
    product_fields: dict[str, Any] | None,
    purchase_fields: dict[str, Any],
) -> dict[str, str]:
    interest = await owned(session, Interest, user_id, interest_id)
    fingerprint = hashlib.sha256(
        json.dumps(
            {"sku_id": sku_id, "product": product_fields, "purchase": purchase_fields},
            sort_keys=True,
            default=str,
        ).encode()
    ).hexdigest()
    receipt = await session.scalar(
        select(InterestConversion).where(
            InterestConversion.interest_id == interest.id, InterestConversion.user_id == user_id
        )
    )
    if receipt:
        if receipt.request_hash != fingerprint:
            raise ConflictError(
                "이미 다른 내용으로 구매 전환했습니다. 연결된 제품에서 추가 구매를 기록하세요"
            )
        purchase = await session.get(Purchase, receipt.purchase_id)
        sku = await session.get(Sku, purchase.sku_id) if purchase else None
        if purchase is None or purchase.deleted_at is not None or sku is None:
            raise ConflictError("전환한 구매가 변경·삭제되었습니다. 제품 기록을 확인하세요")
        return {
            "interest_id": str(interest.id),
            "purchase_id": str(purchase.id),
            "product_id": str(sku.product_id),
        }
    if interest.updated_at != expected_updated_at:
        raise ConflictError("관심 기록이 변경되었습니다. 최신 내용으로 구매 전환을 확인하세요")
    if interest.archived_at:
        raise ConflictError("보관한 관심은 복원한 뒤 구매 전환하세요")
    if sku_id is None:
        assert product_fields is not None
        fields = dict(product_fields)
        volume_ml = fields.pop("volume_ml")
        producer = fields.pop("producer")
        category_id = fields.get("category_id")
        if category_id:
            await owned(session, Category, user_id, category_id)
        producer_id = (
            await resolve_producer_id(session, user_id=user_id, name=producer) if producer else None
        )
        product = Product(
            user_id=user_id,
            normalized_name=normalized_name_of(fields["name"]),
            producer_id=producer_id,
            **fields,
        )
        session.add(product)
        await session.flush()
        sku = Sku(user_id=user_id, product_id=product.id, volume_ml=volume_ml)
        session.add(sku)
        await session.flush()
    else:
        sku = await owned(session, Sku, user_id, sku_id)
        await owned(session, Product, user_id, sku.product_id)
    if vendor_id := purchase_fields.get("vendor_id"):
        await owned(session, Vendor, user_id, vendor_id)
    purchase = Purchase(user_id=user_id, sku_id=sku.id, **purchase_fields)
    session.add(purchase)
    await session.flush()
    for index in range(purchase.quantity):
        session.add(Bottle(user_id=user_id, purchase_id=purchase.id, label_no=index + 1))
    interest.product_id = sku.product_id
    interest.archived_at = datetime.datetime.now(datetime.UTC)
    session.add(
        InterestConversion(
            user_id=user_id,
            interest_id=interest.id,
            purchase_id=purchase.id,
            request_hash=fingerprint,
        )
    )
    await session.flush()
    return {
        "interest_id": str(interest.id),
        "purchase_id": str(purchase.id),
        "product_id": str(sku.product_id),
    }
