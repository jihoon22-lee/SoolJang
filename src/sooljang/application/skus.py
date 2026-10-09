"""규격 식별과 사용 이력 보호. Product → SKU 순서로 살아 있는 부모를 잠근다."""

import datetime
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError
from sooljang.application.barcodes import normalize_optional
from sooljang.application.history import log_event
from sooljang.infrastructure.database.models import Product, Purchase, Sku, TastingSession


async def lock_live_product(
    session: AsyncSession, *, user_id: uuid.UUID, product_id: uuid.UUID
) -> Product:
    product = await session.scalar(
        select(Product)
        .where(Product.id == product_id, Product.user_id == user_id, Product.deleted_at.is_(None))
        # PK는 바꾸지 않는다. 시음 INSERT의 SKU FK KEY SHARE를 막지 않는 잠금이다.
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if product is None:
        raise NotFoundError("제품을 찾을 수 없습니다")
    return product


async def load_live_sku_for_write(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    sku_id: uuid.UUID,
    include_deleted: bool = False,
) -> Sku:
    product_id = await session.scalar(
        select(Sku.product_id).where(Sku.id == sku_id, Sku.user_id == user_id)
    )
    if product_id is None:
        raise NotFoundError("규격을 찾을 수 없습니다")
    await lock_live_product(session, user_id=user_id, product_id=product_id)
    sku = await session.scalar(
        select(Sku)
        .where(Sku.id == sku_id, Sku.user_id == user_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if sku is None or (sku.deleted_at is not None and not include_deleted):
        raise NotFoundError("규격을 찾을 수 없습니다")
    if sku.product_id != product_id:
        raise ConflictError("규격의 제품 연결이 변경되었습니다. 다시 확인하세요")
    return sku


async def ensure_sku_unused(session: AsyncSession, sku: Sku) -> None:
    """삭제된 구매·시음도 과거 사실이다. 바에서 마신 병 없는 시음도 사용으로 센다."""
    purchased = await session.scalar(select(Purchase.id).where(Purchase.sku_id == sku.id).limit(1))
    tasted = await session.scalar(
        select(TastingSession.id).where(TastingSession.sku_id == sku.id).limit(1)
    )
    if purchased is not None or tasted is not None:
        raise ConflictError(
            "구매·시음 기록이 있는 규격은 용량을 바꾸거나 삭제할 수 없습니다. "
            "기록의 규격 정정을 이용하세요"
        )


async def validate_sku_volume_change(session: AsyncSession, sku: Sku, volume_ml: int) -> None:
    if volume_ml != sku.volume_ml:
        await ensure_sku_unused(session, sku)


async def delete_unused_sku(session: AsyncSession, sku: Sku) -> None:
    if sku.deleted_at is None:
        await ensure_sku_unused(session, sku)
        sku.deleted_at = datetime.datetime.now(datetime.UTC)
        await session.flush()


async def create_sku(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    product_id: uuid.UUID,
    volume_ml: int,
    barcode: str | None = None,
    package_note: str | None = None,
    sku_id: uuid.UUID | None = None,
    restore_empty: bool = False,
) -> Sku:
    """명시적 온라인 생성만 깨끗한 미사용 tombstone을 같은 ID로 재사용할 수 있다."""
    await lock_live_product(session, user_id=user_id, product_id=product_id)
    existing = await session.scalar(
        select(Sku)
        .where(Sku.product_id == product_id, Sku.volume_ml == volume_ml)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    normalized, barcode_type = normalize_optional(barcode)
    if existing is not None:
        if existing.user_id != user_id:
            raise ConflictError("규격의 소유 관계를 확인할 수 없습니다")
        if existing.deleted_at is None:
            raise ConflictError("같은 용량의 규격이 이미 있습니다. 기존 규격을 선택하세요")
        if not restore_empty or existing.barcode or existing.barcode_type or existing.package_note:
            raise ConflictError("삭제된 규격의 원본을 보존했습니다. 기존 기록을 먼저 확인하세요")
        await ensure_sku_unused(session, existing)
        existing.deleted_at = None
        existing.barcode = normalized
        existing.barcode_type = barcode_type
        existing.package_note = package_note
        log_event(
            session,
            user_id=user_id,
            entity="sku",
            entity_id=existing.id,
            action="restore",
            detail={"volume_ml": volume_ml},
        )
        await session.flush()
        return existing
    sku = Sku(
        user_id=user_id,
        product_id=product_id,
        volume_ml=volume_ml,
        barcode=normalized,
        barcode_type=barcode_type,
        package_note=package_note,
    )
    if sku_id is not None:
        sku.id = sku_id
    session.add(sku)
    await session.flush()
    return sku
