"""인증된 온라인 정리·보관·실사 API."""

import uuid
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import ConflictError
from sooljang.api.schemas.collection_management import (
    CleanupInput,
    FoundInput,
    LocationInput,
    PlacementInput,
    ScanInput,
    StocktakeInput,
    StocktakeStatusInput,
)
from sooljang.application.collection_cleanup import confirm_cleanup, preview_cleanup, quality_report
from sooljang.application.collection_inventory import (
    list_bottles,
    move_bottle,
    owned,
    scan_bottle,
    start_stocktake,
    stocktake_out,
)
from sooljang.infrastructure.database.models import (
    BottleMovement,
    CleanupPreview,
    Stocktake,
    StorageLocation,
)

router = APIRouter(prefix="/collection", tags=["collection"])


def cleanup_out(row: CleanupPreview) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "kind": row.kind,
        "snapshot": row.snapshot,
        "confirmed": row.confirmed_at is not None,
    }


@router.get("/quality")
async def quality(session: SessionDep, user_id: UserDep) -> dict[str, Any]:
    return await quality_report(session, user_id)


@router.post("/cleanup/preview", status_code=201)
async def preview(payload: CleanupInput, session: SessionDep, user_id: UserDep) -> dict[str, Any]:
    return cleanup_out(
        await preview_cleanup(session, user_id, payload.kind, payload.ids, payload.target_id)
    )


@router.post("/cleanup/{preview_id}/confirm")
async def confirm(preview_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> dict[str, Any]:
    return cleanup_out(await confirm_cleanup(session, user_id, preview_id))


@router.get("/cleanup/history")
async def cleanup_history(session: SessionDep, user_id: UserDep) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(CleanupPreview)
        .where(CleanupPreview.user_id == user_id, CleanupPreview.confirmed_at.is_not(None))
        .order_by(CleanupPreview.confirmed_at.desc())
        .limit(100)
    )
    return [cleanup_out(row) for row in rows]


@router.get("/locations")
async def locations(session: SessionDep, user_id: UserDep) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(StorageLocation)
        .where(StorageLocation.user_id == user_id)
        .order_by(StorageLocation.name)
    )
    bottles = await list_bottles(session, user_id)
    return [
        {
            "id": str(row.id),
            "name": row.name,
            "kind": row.kind,
            "note": row.note,
            "deleted": row.deleted_at is not None,
            "bottle_count": sum(bottle["location_id"] == str(row.id) for bottle in bottles),
        }
        for row in rows
    ]


@router.post("/locations", status_code=201)
async def create_location(
    payload: LocationInput, session: SessionDep, user_id: UserDep
) -> dict[str, str]:
    row = StorageLocation(user_id=user_id, **payload.model_dump())
    session.add(row)
    await session.flush()
    return {"id": str(row.id)}


@router.patch("/locations/{location_id}")
async def update_location(
    location_id: uuid.UUID, payload: LocationInput, session: SessionDep, user_id: UserDep
) -> dict[str, str]:
    row = await owned(session, StorageLocation, user_id, location_id)
    for field, value in payload.model_dump().items():
        setattr(row, field, value)
    await session.flush()
    return {"id": str(row.id)}


@router.get("/bottles")
async def bottles(session: SessionDep, user_id: UserDep) -> list[dict[str, Any]]:
    return await list_bottles(session, user_id)


@router.put("/bottles/{bottle_id}/location")
async def place(
    bottle_id: uuid.UUID, payload: PlacementInput, session: SessionDep, user_id: UserDep
) -> dict[str, bool]:
    await move_bottle(session, user_id, bottle_id, payload.location_id)
    return {"saved": True}


@router.get("/bottles/{bottle_id}/movements")
async def movements(
    bottle_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(BottleMovement)
        .where(BottleMovement.user_id == user_id, BottleMovement.bottle_id == bottle_id)
        .order_by(BottleMovement.created_at.desc())
    )
    return [
        {
            "id": str(row.id),
            "from_location_id": row.from_location_id,
            "to_location_id": row.to_location_id,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.get("/stocktakes")
async def stocktakes(session: SessionDep, user_id: UserDep) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(Stocktake)
        .where(Stocktake.user_id == user_id, Stocktake.deleted_at.is_(None))
        .order_by(Stocktake.created_at.desc())
    )
    return [stocktake_out(row) for row in rows]


@router.post("/stocktakes", status_code=201)
async def create_stocktake(
    payload: StocktakeInput, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    return stocktake_out(await start_stocktake(session, user_id, payload.name, payload.location_id))


@router.patch("/stocktakes/{stocktake_id}")
async def update_stocktake(
    stocktake_id: uuid.UUID, payload: StocktakeStatusInput, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    row = await owned(session, Stocktake, user_id, stocktake_id)
    if row.status == "completed" and payload.status != "completed":
        raise ConflictError("완료한 실사는 새 실사로 다시 확인하세요")
    row.status = payload.status
    await session.flush()
    return stocktake_out(row)


@router.post("/stocktakes/{stocktake_id}/scan")
async def scan(
    stocktake_id: uuid.UUID, payload: ScanInput, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    return await scan_bottle(
        session, user_id, stocktake_id, payload.bottle_code, payload.observed_location_id
    )


@router.post("/stocktakes/{stocktake_id}/found")
async def found(
    stocktake_id: uuid.UUID, payload: FoundInput, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    row = await owned(session, Stocktake, user_id, stocktake_id)
    if row.status != "active":
        raise ConflictError("진행 중인 실사에서만 기록할 수 있습니다")
    if payload.note not in row.found_notes:
        row.found_notes = [*row.found_notes, payload.note]
    await session.flush()
    return stocktake_out(row)
