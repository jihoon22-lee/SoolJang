"""보관 위치 변경과 실사. 실사는 관찰만 남기며 재고 상태를 변경하지 않는다."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.application.tastings import load_bottle_for_write
from sooljang.infrastructure.database.base import EntityMixin
from sooljang.infrastructure.database.models import (
    IN_STOCK_STATUSES,
    Bottle,
    BottleMovement,
    BottlePlacement,
    Product,
    Purchase,
    Sku,
    Stocktake,
    StorageLocation,
)


async def owned[T: EntityMixin](
    session: AsyncSession, model: type[T], user_id: uuid.UUID, entity_id: uuid.UUID
) -> T:
    row = await session.scalar(
        select(model)
        .where(model.id == entity_id, model.user_id == user_id, model.deleted_at.is_(None))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise NotFoundError("기록을 찾을 수 없습니다")
    return row


async def owned_many[T: EntityMixin](
    session: AsyncSession, model: type[T], user_id: uuid.UUID, ids: list[uuid.UUID]
) -> dict[uuid.UUID, T]:
    """여러 행을 한 번에 id 순서로 잠근다. 없는 id 가 있으면 어떤 것인지 알려 준다.

    행마다 `owned()` 를 부르면 200건 선택에 잠금 쿼리가 200번 나간다. id 순서 잠금은
    단건 경로와 같아 서로 다른 일괄 작업 사이의 교착을 막는다.
    """
    unique = sorted(set(ids))
    if not unique:
        return {}
    rows = await session.scalars(
        select(model)
        .where(model.id.in_(unique), model.user_id == user_id, model.deleted_at.is_(None))
        .order_by(model.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    found = {row.id: row for row in rows}
    missing = [entity_id for entity_id in unique if entity_id not in found]
    if missing:
        sample = ", ".join(str(entity_id) for entity_id in missing[:3])
        more = f" 외 {len(missing) - 3}건" if len(missing) > 3 else ""
        raise NotFoundError(f"기록 {len(missing)}건을 찾을 수 없습니다: {sample}{more}")
    return found


async def list_bottles(session: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(Bottle, Product, BottlePlacement)
        .join(Purchase, Bottle.purchase_id == Purchase.id)
        .join(Sku, Purchase.sku_id == Sku.id)
        .join(Product, Sku.product_id == Product.id)
        .outerjoin(BottlePlacement, BottlePlacement.bottle_id == Bottle.id)
        .where(
            Bottle.user_id == user_id,
            Bottle.deleted_at.is_(None),
            # 이전 버전에서 제품만 삭제되고 하위 병이 남은 기록도 목록에서 뺀다.
            Purchase.deleted_at.is_(None),
            Sku.deleted_at.is_(None),
            Product.deleted_at.is_(None),
        )
        .order_by(Product.name, Bottle.label_no)
    )
    return [
        {
            "id": str(bottle.id),
            "product_id": str(product.id),
            "name": product.name,
            "label_no": bottle.label_no,
            "status": bottle.status,
            "location_id": str(placement.location_id)
            if placement and placement.location_id
            else None,
            "legacy_location": bottle.storage_location,
            "bottle_code": f"sooljang:bottle:{bottle.id}",
        }
        for bottle, product, placement in rows
    ]


async def move_bottle(
    session: AsyncSession,
    user_id: uuid.UUID,
    bottle_id: uuid.UUID,
    location_id: uuid.UUID | None,
) -> None:
    # 위치 잠금을 먼저 얻어 위치 삭제와 같은 순서로 직렬화한다.
    if location_id:
        await owned(session, StorageLocation, user_id, location_id)
    bottle = await load_bottle_for_write(session, user_id=user_id, bottle_id=bottle_id)
    if bottle is None:
        raise NotFoundError("병을 찾을 수 없습니다")
    placement = await session.scalar(
        select(BottlePlacement).where(BottlePlacement.bottle_id == bottle_id).with_for_update()
    )
    previous = placement.location_id if placement else None
    if previous == location_id:
        return
    if placement is None:
        placement = BottlePlacement(user_id=user_id, bottle_id=bottle_id)
        session.add(placement)
    placement.location_id = location_id
    session.add(
        BottleMovement(
            user_id=user_id,
            bottle_id=bottle_id,
            from_location_id=previous,
            to_location_id=location_id,
        )
    )
    await session.flush()


async def move_bottles(
    session: AsyncSession,
    user_id: uuid.UUID,
    bottle_ids: list[uuid.UUID],
    location_id: uuid.UUID | None,
) -> dict[str, int]:
    """여러 병을 한 위치로 옮긴다. 전부 성공하거나 전부 취소된다.

    병 하나씩 `move_bottle` 을 부르면 선택 40병에 요청 40번이 오가고 중간 실패 시 일부만
    옮겨진다. 한 트랜잭션에서 id 순서로 잠가 단건 경로·위치 삭제와 같은 순서를 지킨다.
    """
    if location_id:
        await owned(session, StorageLocation, user_id, location_id)
    bottles = await owned_many(session, Bottle, user_id, bottle_ids)
    placements = {
        row.bottle_id: row
        for row in await session.scalars(
            select(BottlePlacement)
            .where(BottlePlacement.bottle_id.in_(list(bottles)))
            .order_by(BottlePlacement.bottle_id)
            .with_for_update()
        )
    }
    moved = 0
    for bottle_id in sorted(bottles):
        placement = placements.get(bottle_id)
        previous = placement.location_id if placement else None
        if previous == location_id:
            continue
        if placement is None:
            placement = BottlePlacement(user_id=user_id, bottle_id=bottle_id)
            session.add(placement)
        placement.location_id = location_id
        session.add(
            BottleMovement(
                user_id=user_id,
                bottle_id=bottle_id,
                from_location_id=previous,
                to_location_id=location_id,
            )
        )
        moved += 1
    await session.flush()
    return {"moved": moved, "unchanged": len(bottles) - moved}


async def apply_observed_locations(
    session: AsyncSession, user_id: uuid.UUID, stocktake_id: uuid.UUID
) -> dict[str, int]:
    """실사에서 기록과 다른 위치로 관찰된 병을 관찰한 위치로 옮긴다.

    실사는 재고 상태를 바꾸지 않는다는 원칙은 그대로다 — 위치만 사용자가 명시적으로 요청할
    때 반영한다. 반영한 관찰은 결과를 `relocated` 로 바꿔 두 번 옮기지 않는다.
    """
    row = await owned(session, Stocktake, user_id, stocktake_id)
    targets: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for observation in row.observations.values():
        if observation["result"] != "location_mismatch":
            continue
        observed = observation["observed_location_id"]
        targets.setdefault(uuid.UUID(observed) if observed else None, []).append(
            uuid.UUID(observation["bottle_id"])
        )
    moved = 0
    for location_id, ids in targets.items():
        moved += (await move_bottles(session, user_id, ids, location_id))["moved"]
    row.observations = {
        key: {**value, "result": "relocated"} if value["result"] == "location_mismatch" else value
        for key, value in row.observations.items()
    }
    await session.flush()
    return {"moved": moved}


async def start_stocktake(
    session: AsyncSession, user_id: uuid.UUID, name: str, location_id: uuid.UUID | None
) -> Stocktake:
    if location_id:
        await owned(session, StorageLocation, user_id, location_id)
    bottles = await list_bottles(session, user_id)
    expected = {
        bottle["id"]: bottle
        for bottle in bottles
        if bottle["status"] in IN_STOCK_STATUSES
        and (location_id is None or bottle["location_id"] == str(location_id))
    }
    row = Stocktake(
        user_id=user_id,
        name=name,
        location_id=location_id,
        expected=expected,
        observations={},
        found_notes=[],
    )
    session.add(row)
    await session.flush()
    return row


def stocktake_out(row: Stocktake) -> dict[str, Any]:
    results = [value["result"] for value in row.observations.values()]
    return {
        "id": str(row.id),
        "name": row.name,
        "status": row.status,
        "location_id": str(row.location_id) if row.location_id else None,
        "expected_count": len(row.expected),
        # 진행률 표시용 요약. 화면이 관찰 목록 전체를 다시 세지 않게 한다.
        "observed_count": len(results),
        "mismatch_count": results.count("location_mismatch"),
        "unexpected_count": results.count("unexpected"),
        "observations": list(row.observations.values()),
        "missing": [value for key, value in row.expected.items() if key not in row.observations],
        "found_notes": row.found_notes,
    }


async def scan_bottle(
    session: AsyncSession,
    user_id: uuid.UUID,
    stocktake_id: uuid.UUID,
    code: str,
    observed_location_id: uuid.UUID | None,
) -> dict[str, Any]:
    if not code.startswith("sooljang:bottle:"):
        raise ValidationFailedError("제품 바코드와 구분된 술장 병 QR을 사용하세요")
    try:
        bottle_id = uuid.UUID(code.removeprefix("sooljang:bottle:"))
    except ValueError as exc:
        raise ValidationFailedError("올바른 병 QR이 아닙니다") from exc
    if observed_location_id:
        await owned(session, StorageLocation, user_id, observed_location_id)
    row = await owned(session, Stocktake, user_id, stocktake_id)
    if row.status != "active":
        raise ConflictError("진행 중인 실사에서만 확인할 수 있습니다")
    bottle = await load_bottle_for_write(session, user_id=user_id, bottle_id=bottle_id)
    if bottle is None:
        raise NotFoundError("이 계정의 병을 찾을 수 없습니다")
    if bottle.status not in IN_STOCK_STATUSES:
        raise ConflictError("현재 재고가 아닌 병입니다. 제품 상세에서 상태를 확인하세요")
    key = str(bottle_id)
    if key in row.observations:
        return {"duplicate": True, "observation": row.observations[key]}
    placement = await session.scalar(
        select(BottlePlacement).where(BottlePlacement.bottle_id == bottle_id)
    )
    actual = placement.location_id if placement else None
    observation = {
        "bottle_id": key,
        "result": "location_mismatch"
        if actual != observed_location_id
        else ("checked" if key in row.expected else "unexpected"),
        "recorded_location_id": str(actual) if actual else None,
        "observed_location_id": str(observed_location_id) if observed_location_id else None,
    }
    row.observations = {**row.observations, key: observation}
    await session.flush()
    return {"duplicate": False, "observation": observation}
