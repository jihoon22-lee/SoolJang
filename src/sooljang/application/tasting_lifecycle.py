"""기록만 삭제·복구한다. 현재 잔량과 상태는 별도의 명시적 정정만 바꾼다."""

import datetime
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError
from sooljang.api.schemas.tasting_lifecycle import TastingLifecycleRequest, TastingLifecycleResult
from sooljang.application.corrections import _lock_graph, _receipt, _save_receipt
from sooljang.application.history import log_event
from sooljang.infrastructure.database.models import Bottle, Purchase, TastingSession


async def change_tasting_visibility(
    session: AsyncSession,
    user_id: uuid.UUID,
    tasting_id: uuid.UUID,
    payload: TastingLifecycleRequest,
    *,
    restore: bool = False,
) -> TastingLifecycleResult:
    """다른 기기의 변경은 409로 보존하고 같은 요청의 응답 유실은 재실행 없이 확인한다."""
    action = "restore" if restore else "delete"
    replay = await _receipt(session, user_id, "tasting_session", tasting_id, action, payload)
    if replay is not None:
        return TastingLifecycleResult.model_validate(replay)
    initial = await session.scalar(
        select(TastingSession).where(
            TastingSession.id == tasting_id, TastingSession.user_id == user_id
        )
    )
    if initial is None:
        raise NotFoundError("시음 기록을 찾을 수 없습니다")
    original = (initial.sku_id, initial.bottle_id)
    bottle_ids = {initial.bottle_id} if initial.bottle_id else set()
    purchase_ids = set(
        await session.scalars(
            select(Bottle.purchase_id).where(Bottle.id.in_(bottle_ids), Bottle.user_id == user_id)
        )
    )
    sku_ids = {
        initial.sku_id,
        *await session.scalars(
            select(Purchase.sku_id).where(
                Purchase.id.in_(purchase_ids), Purchase.user_id == user_id
            )
        ),
    }
    _, _, bottles, tastings = await _lock_graph(
        session, user_id, sku_ids, purchase_ids, bottle_ids, {tasting_id}, deleted_children=True
    )
    record = tastings[tasting_id]
    if any(bottle.deleted_at is not None for bottle in bottles.values()):
        raise ConflictError("연결된 병이 삭제되어 기록을 바꿀 수 없습니다")
    if (record.sku_id, record.bottle_id) != original:
        raise ConflictError("시음 연결이 변경되었습니다. 최신 기록을 확인하세요")
    if record.updated_at != payload.expected_updated_at or (record.deleted_at is None) == restore:
        raise ConflictError("시음 기록이 변경되었습니다. 최신 기록을 확인한 뒤 다시 시도하세요")
    now = datetime.datetime.now(datetime.UTC)
    record.deleted_at = None if restore else now
    record.updated_at = now
    for bottle in bottles.values():
        bottle.revision = uuid.uuid4()
        log_event(
            session,
            user_id=user_id,
            entity="bottle",
            entity_id=bottle.id,
            action=f"tasting_{action}",
            detail={"tasting_id": tasting_id},
        )
    log_event(
        session,
        user_id=user_id,
        entity="tasting_session",
        entity_id=tasting_id,
        action=action,
        detail={"request_id": payload.request_id},
    )
    await session.flush()
    result = TastingLifecycleResult(
        id=tasting_id, updated_at=record.updated_at, deleted_at=record.deleted_at
    )
    _save_receipt(session, user_id, "tasting_session", tasting_id, action, payload, result)
    await session.flush()
    return result
