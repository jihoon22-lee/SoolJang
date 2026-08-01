"""동기화 라우터.

`GET /sync`(델타 풀), `POST /sync/batch`(outbox 일괄 적용),
`POST /sync/conflicts/{id}:resolve`(충돌 확인 처리). `docs/architecture.md` §4.2·§5.
"""

import datetime
import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import NotFoundError
from sooljang.api.pagination import Cursor
from sooljang.api.schemas.sync import (
    SyncBatchIn,
    SyncBatchOut,
    SyncOperationResultOut,
    SyncPullOut,
)
from sooljang.application.sync import SyncOperation, apply_batch, pull_changes
from sooljang.infrastructure.database.models import ConflictLog

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("", response_model=SyncPullOut, summary="델타 풀")
async def pull(
    session: SessionDep,
    user_id: UserDep,
    since: Annotated[str | None, Query(description="이전 응답의 next_cursor")] = None,
) -> SyncPullOut:
    cursor = Cursor.decode(since) if since else None
    result = await pull_changes(session, user_id=user_id, cursor=cursor)
    return SyncPullOut(
        changes=result.changes, next_cursor=result.next_cursor, has_more=result.has_more
    )


@router.post("/batch", response_model=SyncBatchOut, summary="outbox 일괄 전송")
async def batch(session: SessionDep, user_id: UserDep, payload: SyncBatchIn) -> SyncBatchOut:
    operations = [
        SyncOperation(
            idempotency_key=item.idempotency_key,
            entity=item.entity,
            op=item.op,
            entity_id=item.entity_id,
            base_updated_at=item.base_updated_at,
            action=item.action,
            fields=item.fields,
        )
        for item in payload.operations
    ]
    result = await apply_batch(session, user_id=user_id, operations=operations)
    return SyncBatchOut(
        results=[
            SyncOperationResultOut(
                idempotency_key=r.idempotency_key,
                status=r.status,
                detail=r.detail,
                snapshot=r.snapshot,
            )
            for r in result.results
        ],
        stopped=result.stopped,
    )


@router.post(
    "/conflicts/{conflict_id}:resolve",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="충돌 확인 처리",
)
async def resolve_conflict(conflict_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    """충돌을 확인했다는 표시로 soft delete 한다. 풀 대상이라 다른 기기에도 전파된다."""
    conflict = await session.get(ConflictLog, conflict_id)
    if conflict is None or conflict.user_id != user_id:
        raise NotFoundError(f"충돌 기록을 찾을 수 없습니다: {conflict_id}")
    if conflict.deleted_at is None:
        conflict.deleted_at = datetime.datetime.now(datetime.UTC)
        await session.flush()
