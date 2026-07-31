"""구매처·구매 건 라우터.

`POST /purchases/{id}:split` 이 이 모듈의 핵심이다. 레거시 임포트는 한 행을 합성 구매 건
하나로 만들 수밖에 없는데(엑셀에 구매 건 구분이 없다), 실제로는 28행이 여러 구매처를 한 셀에
담고 있었다. 사용자가 나중에 이를 쪼갤 수 있어야 임포트한 데이터가 정확해진다.
"""

import datetime
import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import func, select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.api.schemas.product import (
    BottleOut,
    PurchaseCreate,
    PurchaseOut,
    PurchaseSplit,
    PurchaseUpdate,
    VendorCreate,
    VendorOut,
    VendorUpdate,
)
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Purchase,
    Sku,
    Vendor,
)

vendors_router = APIRouter(prefix="/vendors", tags=["vendors"])
purchases_router = APIRouter(prefix="/purchases", tags=["purchases"])


# --- 구매처 -----------------------------------------------------------------


@vendors_router.get("", response_model=list[VendorOut], summary="구매처 목록")
async def list_vendors(session: SessionDep, user_id: UserDep) -> list[VendorOut]:
    """구매처 목록과 각 구매처의 구매 건 수.

    레거시 실측 82곳 수준이라 페이지네이션하지 않는다. 선택 목록으로 쓰이므로 전체가 필요하다.
    """
    counts = {
        row[0]: row[1]
        for row in await session.execute(
            select(Purchase.vendor_id, func.count())
            .where(Purchase.user_id == user_id, Purchase.deleted_at.is_(None))
            .group_by(Purchase.vendor_id)
        )
    }
    vendors = await session.scalars(
        select(Vendor)
        .where(Vendor.user_id == user_id, Vendor.deleted_at.is_(None))
        .order_by(Vendor.name)
    )
    return [
        VendorOut(
            id=vendor.id,
            name=vendor.name,
            kind=vendor.kind,
            url=vendor.url,
            note=vendor.note,
            purchase_count=counts.get(vendor.id, 0),
        )
        for vendor in vendors
    ]


@vendors_router.post(
    "", response_model=VendorOut, status_code=status.HTTP_201_CREATED, summary="구매처 등록"
)
async def create_vendor(payload: VendorCreate, session: SessionDep, user_id: UserDep) -> VendorOut:
    vendor = Vendor(
        user_id=user_id,
        name=payload.name.strip(),
        kind=payload.kind,
        url=payload.url,
        note=payload.note,
    )
    session.add(vendor)
    await session.flush()
    return VendorOut.model_validate(vendor)


@vendors_router.patch("/{vendor_id}", response_model=VendorOut, summary="구매처 수정")
async def update_vendor(
    vendor_id: uuid.UUID, payload: VendorUpdate, session: SessionDep, user_id: UserDep
) -> VendorOut:
    vendor = await _owned_vendor(session, user_id, vendor_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(vendor, key, value)
    await session.flush()
    return VendorOut.model_validate(vendor)


@vendors_router.delete(
    "/{vendor_id}", status_code=status.HTTP_204_NO_CONTENT, summary="구매처 삭제"
)
async def delete_vendor(vendor_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    """구매처를 soft delete 한다. 구매 건이 남아 있으면 거부한다.

    구매 건의 구매처를 NULL 로 만들면 "어디서 샀는지 모름" 과 구분할 수 없게 된다.
    """
    vendor = await _owned_vendor(session, user_id, vendor_id)
    in_use = await session.scalar(
        select(func.count())
        .select_from(Purchase)
        .where(Purchase.vendor_id == vendor_id, Purchase.deleted_at.is_(None))
    )
    if in_use:
        raise ConflictError(f"구매 건 {in_use}개가 이 구매처를 참조합니다")
    vendor.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()


async def _owned_vendor(session: SessionDep, user_id: uuid.UUID, vendor_id: uuid.UUID) -> Vendor:
    vendor = await session.get(Vendor, vendor_id)
    if vendor is None or vendor.deleted_at is not None or vendor.user_id != user_id:
        raise NotFoundError(f"구매처를 찾을 수 없습니다: {vendor_id}")
    return vendor


# --- 구매 건 ----------------------------------------------------------------


async def _to_purchase_out(session: SessionDep, purchase: Purchase) -> PurchaseOut:
    """구매 건 응답을 만든다.

    응답 전에 새로 읽는다. flush 직후의 인메모리 값은 입력 그대로여서 `85000` 이지만 DB 에
    저장된 값은 `Numeric(14,2)` 라 `85000.00` 이다. 생성 직후와 재조회 응답의 형식이 다르면
    클라이언트가 같은 필드를 두 방식으로 처리해야 한다.
    """
    await session.refresh(purchase)
    sku = await session.get(Sku, purchase.sku_id)
    vendor = await session.get(Vendor, purchase.vendor_id) if purchase.vendor_id else None
    bottle_count = await session.scalar(
        select(func.count())
        .select_from(Bottle)
        .where(Bottle.purchase_id == purchase.id, Bottle.deleted_at.is_(None))
    )
    quantity = Decimal(purchase.quantity)
    return PurchaseOut(
        id=purchase.id,
        sku_id=purchase.sku_id,
        volume_ml=sku.volume_ml if sku else None,
        vendor_id=purchase.vendor_id,
        vendor_name=vendor.name if vendor else None,
        purchased_on=purchase.purchased_on,
        quantity=purchase.quantity,
        unit_list_price=purchase.unit_list_price,
        unit_paid_price=purchase.unit_paid_price,
        list_total=purchase.unit_list_price * quantity
        if purchase.unit_list_price is not None
        else None,
        paid_total=purchase.unit_paid_price * quantity
        if purchase.unit_paid_price is not None
        else None,
        currency=purchase.currency,
        fx_rate=purchase.fx_rate,
        foreign_unit_price=purchase.foreign_unit_price,
        discount_note=purchase.discount_note,
        import_note=purchase.import_note,
        bottle_count=bottle_count or 0,
    )


@purchases_router.get("", response_model=list[PurchaseOut], summary="구매 건 목록")
async def list_purchases(
    session: SessionDep,
    user_id: UserDep,
    product_id: Annotated[uuid.UUID | None, Query(description="제품으로 필터")] = None,
    sku_id: Annotated[uuid.UUID | None, Query()] = None,
    vendor_id: Annotated[uuid.UUID | None, Query()] = None,
) -> list[PurchaseOut]:
    statement = (
        select(Purchase)
        .where(Purchase.user_id == user_id, Purchase.deleted_at.is_(None))
        .order_by(Purchase.purchased_on.desc().nullslast(), Purchase.created_at.desc())
    )
    if sku_id is not None:
        statement = statement.where(Purchase.sku_id == sku_id)
    if vendor_id is not None:
        statement = statement.where(Purchase.vendor_id == vendor_id)
    if product_id is not None:
        statement = statement.where(
            Purchase.sku_id.in_(select(Sku.id).where(Sku.product_id == product_id))
        )

    purchases = (await session.scalars(statement)).all()
    return [await _to_purchase_out(session, purchase) for purchase in purchases]


@purchases_router.post(
    "", response_model=PurchaseOut, status_code=status.HTTP_201_CREATED, summary="구매 건 등록"
)
async def create_purchase(
    payload: PurchaseCreate, session: SessionDep, user_id: UserDep
) -> PurchaseOut:
    """구매 건을 등록한다. 병 레코드를 병수만큼 자동 생성한다.

    같은 제품에 구매처·가격이 다른 구매 건을 여러 개 만들 수 있다. 엑셀에서 불가능했던
    기록이며 이 프로젝트의 존재 이유다.
    """
    sku = await session.get(Sku, payload.sku_id)
    if sku is None or sku.deleted_at is not None or sku.user_id != user_id:
        raise NotFoundError(f"규격을 찾을 수 없습니다: {payload.sku_id}")
    if payload.vendor_id is not None:
        await _owned_vendor(session, user_id, payload.vendor_id)

    purchase = Purchase(
        user_id=user_id,
        sku_id=payload.sku_id,
        vendor_id=payload.vendor_id,
        purchased_on=payload.purchased_on,
        quantity=payload.quantity,
        unit_list_price=payload.unit_list_price,
        unit_paid_price=payload.unit_paid_price,
        currency=payload.currency.upper(),
        fx_rate=payload.fx_rate,
        foreign_unit_price=payload.foreign_unit_price,
        discount_note=payload.discount_note,
    )
    session.add(purchase)
    await session.flush()

    if payload.create_bottles:
        _add_bottles(session, user_id, purchase, count=payload.quantity, start=1)
        await session.flush()

    return await _to_purchase_out(session, purchase)


@purchases_router.patch("/{purchase_id}", response_model=PurchaseOut, summary="구매 건 수정")
async def update_purchase(
    purchase_id: uuid.UUID, payload: PurchaseUpdate, session: SessionDep, user_id: UserDep
) -> PurchaseOut:
    purchase = await _owned_purchase(session, user_id, purchase_id)
    fields = payload.model_dump(exclude_unset=True)
    if "vendor_id" in fields and fields["vendor_id"] is not None:
        await _owned_vendor(session, user_id, fields["vendor_id"])
    if "currency" in fields and fields["currency"]:
        fields["currency"] = fields["currency"].upper()
    for key, value in fields.items():
        setattr(purchase, key, value)
    await session.flush()
    return await _to_purchase_out(session, purchase)


@purchases_router.delete(
    "/{purchase_id}", status_code=status.HTTP_204_NO_CONTENT, summary="구매 건 삭제"
)
async def delete_purchase(purchase_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    """구매 건과 그에 속한 병을 함께 soft delete 한다."""
    purchase = await _owned_purchase(session, user_id, purchase_id)
    now = datetime.datetime.now(datetime.UTC)
    purchase.deleted_at = now
    bottles = await session.scalars(
        select(Bottle).where(Bottle.purchase_id == purchase_id, Bottle.deleted_at.is_(None))
    )
    for bottle in bottles:
        bottle.deleted_at = now
    await session.flush()


@purchases_router.get(
    "/{purchase_id}/bottles", response_model=list[BottleOut], summary="구매 건의 병 목록"
)
async def list_bottles(
    purchase_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> list[BottleOut]:
    await _owned_purchase(session, user_id, purchase_id)
    bottles = await session.scalars(
        select(Bottle)
        .where(Bottle.purchase_id == purchase_id, Bottle.deleted_at.is_(None))
        .order_by(Bottle.label_no)
    )
    return [BottleOut.model_validate(bottle) for bottle in bottles]


@purchases_router.post(
    "/{purchase_id}:split", response_model=list[PurchaseOut], summary="구매 건 분할"
)
async def split_purchase(
    purchase_id: uuid.UUID, payload: PurchaseSplit, session: SessionDep, user_id: UserDep
) -> list[PurchaseOut]:
    """구매 건을 여러 개로 쪼갠다.

    레거시 임포트가 만든 합성 구매 건을 실제 구매처·가격별로 나누는 경로다. 조각의 병수
    합계가 원본과 같아야 한다. 다르면 병 레코드와 구매 병수가 어긋난다.

    원본의 병 레코드는 조각에 순서대로 재배치한다. 병을 새로 만들면 시음 기록이 끊긴다.
    """
    purchase = await _owned_purchase(session, user_id, purchase_id)

    total = sum(part.quantity for part in payload.parts)
    if total != purchase.quantity:
        raise ValidationFailedError(
            f"조각의 병수 합계({total})가 원본 병수({purchase.quantity})와 다릅니다"
        )

    bottles = list(
        await session.scalars(
            select(Bottle)
            .where(Bottle.purchase_id == purchase_id, Bottle.deleted_at.is_(None))
            .order_by(Bottle.label_no)
        )
    )

    created: list[Purchase] = []
    bottle_index = 0
    for part in payload.parts:
        child = Purchase(
            user_id=user_id,
            sku_id=purchase.sku_id,
            vendor_id=part.vendor_id if part.vendor_id is not None else purchase.vendor_id,
            purchased_on=part.purchased_on
            if part.purchased_on is not None
            else purchase.purchased_on,
            quantity=part.quantity,
            unit_list_price=part.unit_list_price
            if part.unit_list_price is not None
            else purchase.unit_list_price,
            unit_paid_price=part.unit_paid_price
            if part.unit_paid_price is not None
            else purchase.unit_paid_price,
            currency=purchase.currency,
            fx_rate=purchase.fx_rate,
            foreign_unit_price=purchase.foreign_unit_price,
            discount_note=purchase.discount_note,
            import_note=purchase.import_note,
        )
        session.add(child)
        await session.flush()
        created.append(child)

        moved = bottles[bottle_index : bottle_index + part.quantity]
        for label_no, bottle in enumerate(moved, start=1):
            bottle.purchase_id = child.id
            bottle.label_no = label_no
        bottle_index += part.quantity
        if len(moved) < part.quantity:
            # 원본에 병 레코드가 부족했던 경우다. 부족분만 새로 만든다.
            _add_bottles(
                session,
                user_id,
                child,
                count=part.quantity - len(moved),
                start=len(moved) + 1,
            )
        await session.flush()

    purchase.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()

    return [await _to_purchase_out(session, child) for child in created]


def _add_bottles(
    session: SessionDep, user_id: uuid.UUID, purchase: Purchase, *, count: int, start: int
) -> None:
    for offset in range(count):
        session.add(
            Bottle(
                user_id=user_id,
                purchase_id=purchase.id,
                label_no=start + offset,
                status=BottleStatus.UNOPENED,
            )
        )


async def _owned_purchase(
    session: SessionDep, user_id: uuid.UUID, purchase_id: uuid.UUID
) -> Purchase:
    purchase = await session.get(Purchase, purchase_id)
    if purchase is None or purchase.deleted_at is not None or purchase.user_id != user_id:
        raise NotFoundError(f"구매 건을 찾을 수 없습니다: {purchase_id}")
    return purchase
