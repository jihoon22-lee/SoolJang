"""공유 관심 목록·노트·출처 고정·보관 API."""

import uuid
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.schemas.interests import InterestCreate, InterestRevision, InterestUpdate
from sooljang.application.interests import (
    create_interest,
    interest_out,
    set_interest_deleted,
    update_interest,
)
from sooljang.infrastructure.database.models.interest import Interest

router = APIRouter(prefix="/interests", tags=["interests"])


@router.get("")
async def list_interests(
    session: SessionDep, user_id: UserDep, include_deleted: bool = False
) -> list[dict[str, Any]]:
    query = select(Interest).where(Interest.user_id == user_id)
    if not include_deleted:
        query = query.where(Interest.deleted_at.is_(None))
    rows = await session.scalars(query.order_by(Interest.created_at.desc(), Interest.id))
    return [interest_out(row) for row in rows]


@router.delete("/{interest_id}")
async def delete_interest(
    interest_id: uuid.UUID, payload: InterestRevision, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    return interest_out(
        await set_interest_deleted(
            session,
            user_id,
            interest_id,
            expected_updated_at=payload.expected_updated_at,
            deleted=True,
        )
    )


@router.post("/{interest_id}/restore")
async def restore_interest(
    interest_id: uuid.UUID, payload: InterestRevision, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    return interest_out(
        await set_interest_deleted(
            session,
            user_id,
            interest_id,
            expected_updated_at=payload.expected_updated_at,
            deleted=False,
        )
    )


@router.post("", status_code=201)
async def post_interest(
    payload: InterestCreate, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    fields = payload.model_dump(mode="json")
    return interest_out(await create_interest(session, user_id, **fields))


@router.patch("/{interest_id}")
async def patch_interest(
    interest_id: uuid.UUID, payload: InterestUpdate, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    fields = payload.model_dump(mode="json", exclude_unset=True, exclude={"expected_updated_at"})
    return interest_out(
        await update_interest(
            session,
            user_id,
            interest_id,
            expected_updated_at=payload.expected_updated_at,
            fields=fields,
        )
    )
