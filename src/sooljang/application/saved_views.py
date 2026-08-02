"""저장된 피벗 뷰 CRUD(Task 20).

`definition` 은 그대로 불투명한 JSON 으로 다룬다 — `api/schemas/stats.py::PivotRequest`
의 모양을 서버가 검증하지 않는다. 저장은 "나중에 그대로 다시 보여줄 값"일 뿐이고, 실제
실행은 사용자가 불러온 정의를 다시 `POST /stats/pivot` 에 보낼 때 그 스키마가 검증한다 —
검증을 두 번 하지 않는다.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import NotFoundError
from sooljang.infrastructure.database.models import SavedView


async def list_saved_views(session: AsyncSession, *, user_id: uuid.UUID) -> list[SavedView]:
    result = await session.execute(
        select(SavedView)
        .where(SavedView.user_id == user_id, SavedView.deleted_at.is_(None))
        .order_by(SavedView.created_at.desc())
    )
    return list(result.scalars().all())


async def load_saved_view(
    session: AsyncSession, *, user_id: uuid.UUID, view_id: uuid.UUID
) -> SavedView:
    view = await session.scalar(
        select(SavedView).where(
            SavedView.id == view_id,
            SavedView.user_id == user_id,
            SavedView.deleted_at.is_(None),
        )
    )
    if view is None:
        raise NotFoundError(f"저장된 뷰를 찾을 수 없습니다: {view_id}")
    return view


async def create_saved_view(
    session: AsyncSession, *, user_id: uuid.UUID, name: str, definition: dict[str, Any]
) -> SavedView:
    view = SavedView(user_id=user_id, name=name, definition=definition)
    session.add(view)
    await session.flush()
    return view


async def update_saved_view(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    view_id: uuid.UUID,
    name: str | None,
    definition: dict[str, Any] | None,
) -> SavedView:
    view = await load_saved_view(session, user_id=user_id, view_id=view_id)
    if name is not None:
        view.name = name
    if definition is not None:
        view.definition = definition
    return view


async def delete_saved_view(
    session: AsyncSession, *, user_id: uuid.UUID, view_id: uuid.UUID
) -> None:
    view = await load_saved_view(session, user_id=user_id, view_id=view_id)
    view.deleted_at = datetime.now(UTC)
