"""공유 관심 목록·노트·출처 고정·보관 API."""

import uuid
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.schemas.interests import InterestCreate, InterestUpdate
from sooljang.application.interests import create_interest, interest_out, update_interest
from sooljang.infrastructure.database.models.interest import Interest

router = APIRouter(prefix="/interests", tags=["interests"])


@router.get("")
async def list_interests(session: SessionDep, user_id: UserDep) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(Interest)
        .where(Interest.user_id == user_id, Interest.deleted_at.is_(None))
        .order_by(Interest.created_at.desc())
    )
    return [interest_out(row) for row in rows]


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
