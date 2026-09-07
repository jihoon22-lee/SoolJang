"""정리의 미리보기·재검증·일괄 원자적 확정과 영향 기록."""

import datetime
import uuid
from collections import defaultdict
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, ValidationFailedError
from sooljang.application.collection_inventory import owned
from sooljang.infrastructure.database.base import EntityMixin
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleMovement,
    BottlePlacement,
    Category,
    CleanupPreview,
    Product,
    Purchase,
    Sku,
    Stocktake,
    StorageLocation,
    Vendor,
)


def _fact(row: Any) -> dict[str, Any]:
    return {
        column.name: str(value) if value is not None else None
        for column in row.__table__.columns
        if column.name not in {"note", "import_note", "discount_note", "url"}
        for value in [getattr(row, column.name)]
    }


async def snapshot(
    session: AsyncSession,
    user_id: uuid.UUID,
    kind: str,
    ids: list[uuid.UUID],
    target_id: uuid.UUID | None,
) -> dict[str, Any]:
    models = {
        "vendor_merge": Vendor,
        "product_category": Product,
        "purchase_vendor": Purchase,
        "location_delete": StorageLocation,
    }
    model = models[kind]
    if len(set(ids)) != len(ids):
        raise ValidationFailedError("중복 선택을 제거하세요")
    if kind in {"vendor_merge", "location_delete"} and len(ids) != 1:
        raise ValidationFailedError("한 번에 원본 하나를 선택하세요")
    if kind == "vendor_merge" and (target_id is None or target_id in ids):
        raise ValidationFailedError("다른 대상 구매처를 선택하세요")
    if kind == "location_delete" and target_id is not None:
        raise ValidationFailedError("위치 삭제 시 병은 미지정으로 옮깁니다")
    target = None
    if kind == "vendor_merge":
        assert target_id is not None
        # 반대 방향 병합도 같은 두 구매처를 UUID 순서로 잠근다.
        locked = {
            entity_id: await owned(session, Vendor, user_id, entity_id)
            for entity_id in sorted([*ids, target_id])
        }
        rows = [locked[entity_id] for entity_id in sorted(ids)]
        target = locked[target_id]
    else:
        if target_id:
            target_model = Category if kind == "product_category" else Vendor
            target = await owned(session, target_model, user_id, target_id)
        rows = [await owned(session, model, user_id, entity_id) for entity_id in sorted(ids)]
    purchases: list[Purchase] = []
    placements: list[BottlePlacement] = []
    stocktakes: list[Stocktake] = []
    if kind == "vendor_merge":
        purchases = list(
            await session.scalars(
                select(Purchase)
                .where(
                    Purchase.user_id == user_id,
                    Purchase.vendor_id.in_([*ids, target_id]),
                    Purchase.deleted_at.is_(None),
                )
                .order_by(Purchase.id)
                .with_for_update()
            )
        )
    elif kind == "purchase_vendor":
        purchases = [row for row in rows if isinstance(row, Purchase)]
    elif kind == "location_delete":
        placements = list(
            await session.scalars(
                select(BottlePlacement)
                .where(BottlePlacement.user_id == user_id, BottlePlacement.location_id == ids[0])
                .order_by(BottlePlacement.id)
                .with_for_update()
            )
        )
        stocktakes = list(
            await session.scalars(
                select(Stocktake)
                .where(Stocktake.user_id == user_id, Stocktake.location_id == ids[0])
                .order_by(Stocktake.id)
                .with_for_update()
            )
        )
    affected = [p for p in purchases if kind != "vendor_merge" or p.vendor_id == ids[0]]
    return {
        "rows": [_fact(row) for row in rows],
        "target": _fact(target) if target else None,
        "purchases": [_fact(row) for row in purchases],
        "placements": [_fact(row) for row in placements],
        "stocktakes": [{"id": str(row.id), "status": row.status} for row in stocktakes],
        "affected_count": len(affected)
        if kind in {"vendor_merge", "purchase_vendor"}
        else (len(placements) if kind == "location_delete" else len(rows)),
        "bottle_count": sum(p.quantity for p in affected),
        "known_paid_total": str(
            sum(
                (p.unit_paid_price * p.quantity for p in affected if p.unit_paid_price is not None),
                Decimal(0),
            )
        ),
        "unknown_price_count": 0,
    }


async def preview_cleanup(
    session: AsyncSession,
    user_id: uuid.UUID,
    kind: str,
    ids: list[uuid.UUID],
    target_id: uuid.UUID | None,
) -> CleanupPreview:
    facts = await snapshot(session, user_id, kind, ids, target_id)
    row = CleanupPreview(
        user_id=user_id,
        kind=kind,
        selection={
            "ids": [str(value) for value in ids],
            "target_id": str(target_id) if target_id else None,
        },
        snapshot=facts,
    )
    session.add(row)
    await session.flush()
    return row


async def confirm_cleanup(
    session: AsyncSession, user_id: uuid.UUID, preview_id: uuid.UUID
) -> CleanupPreview:
    preview = await owned(session, CleanupPreview, user_id, preview_id)
    if preview.confirmed_at is not None:
        return preview
    ids = [uuid.UUID(value) for value in preview.selection["ids"]]
    target_id = (
        uuid.UUID(preview.selection["target_id"]) if preview.selection["target_id"] else None
    )
    current = await snapshot(session, user_id, preview.kind, ids, target_id)
    if current != preview.snapshot:
        raise ConflictError("미리보기 이후 기록이 변경되었습니다. 다시 미리보기를 확인하세요")
    if preview.kind == "vendor_merge":
        for fact in current["purchases"]:
            if fact["vendor_id"] == str(ids[0]):
                purchase = await owned(session, Purchase, user_id, uuid.UUID(fact["id"]))
                purchase.vendor_id = target_id
        source = await owned(session, Vendor, user_id, ids[0])
        source.deleted_at = datetime.datetime.now(datetime.UTC)
    elif preview.kind in {"product_category", "purchase_vendor"}:
        model = Product if preview.kind == "product_category" else Purchase
        field = "category_id" if preview.kind == "product_category" else "vendor_id"
        for entity_id in ids:
            row = await owned(session, model, user_id, entity_id)
            setattr(row, field, target_id)
    else:
        location = await owned(session, StorageLocation, user_id, ids[0])
        for fact in current["placements"]:
            placement = await owned(session, BottlePlacement, user_id, uuid.UUID(fact["id"]))
            session.add(
                BottleMovement(
                    user_id=user_id,
                    bottle_id=placement.bottle_id,
                    from_location_id=location.id,
                    to_location_id=None,
                )
            )
            placement.location_id = None
        location.deleted_at = datetime.datetime.now(datetime.UTC)
    preview.confirmed_at = datetime.datetime.now(datetime.UTC)
    await session.flush()
    return preview


async def quality_report(session: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    async def rows[T: EntityMixin](model: type[T]) -> list[T]:
        return list(
            await session.scalars(
                select(model).where(model.user_id == user_id, model.deleted_at.is_(None))
            )
        )

    products, skus, purchases, vendors = (
        await rows(Product),
        await rows(Sku),
        await rows(Purchase),
        await rows(Vendor),
    )
    bottles = await rows(Bottle)
    sku_products = {row.id: row.product_id for row in skus}
    items: list[dict[str, Any]] = []

    def add(kind: str, row: Any, reason: str, product_id: uuid.UUID | None = None) -> None:
        items.append(
            {
                "kind": kind,
                "id": str(row.id),
                "name": getattr(row, "name", None),
                "reason": reason,
                "product_id": str(product_id) if product_id else None,
            }
        )

    products_with_skus = {sku.product_id for sku in skus}
    for product in products:
        if product.id not in products_with_skus:
            add("product", product, "volume", product.id)
        if not product.name.strip():
            add("product", product, "name", product.id)
        if product.category_id is None:
            add("product", product, "category", product.id)
    for sku in skus:
        if sku.volume_ml is None:
            add("sku", sku, "volume", sku.product_id)
    for purchase in purchases:
        if purchase.vendor_id is None:
            add("purchase", purchase, "vendor", sku_products.get(purchase.sku_id))
    duplicates: list[dict[str, Any]] = []
    for kind, candidates in (("product", products), ("vendor", vendors)):
        groups: dict[str, list[Any]] = defaultdict(list)
        for row in candidates:
            key = "".join(char for char in row.name.casefold() if char.isalnum())
            if key:
                groups[key].append(row)
        for group in groups.values():
            if len(group) > 1:
                duplicates.append(
                    {
                        "kind": kind,
                        "items": [{"id": str(row.id), "name": row.name} for row in group],
                    }
                )
    placements = await rows(BottlePlacement)
    located = {row.bottle_id for row in placements if row.location_id is not None}
    return {
        "items": items,
        "duplicate_candidates": duplicates,
        "coverage": {
            "purchases": len(purchases),
            "known_price_purchases": len(purchases),
            "unknown_price_purchases": 0,
            "known_paid_total": str(
                sum(
                    (
                        p.unit_paid_price * p.quantity
                        for p in purchases
                        if p.unit_paid_price is not None
                    ),
                    Decimal(0),
                )
            ),
            "skus": len(skus),
            "unknown_volume_skus": sum(s.volume_ml is None for s in skus),
            "unassigned_stock_bottles": sum(
                b.counts_as_stock and b.id not in located for b in bottles
            ),
        },
        "rules": (
            "구매 가격 공란은 선물·포인트 구매 등의 0원으로 포함합니다. "
            "관심 저장과 실사 관찰은 지출·재고 상태를 변경하지 않습니다."
        ),
    }
