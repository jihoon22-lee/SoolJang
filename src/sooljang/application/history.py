"""기록 변경 이력 남기기·읽기.

상태 전이·구매 수정 서비스가 직접 부른다. 온라인 API·동기화 배치가 같은 서비스 함수를
거치므로 어느 경로로 바뀌어도 이력이 한 번 남는다.
"""

import datetime
import decimal
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import BottleMovement, RecordEvent


def _plain(value: Any) -> Any:
    """JSONB 에 그대로 넣을 수 있는 값으로 바꾼다."""
    if isinstance(value, datetime.date | datetime.datetime):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        # "9000" 과 "9000.00" 이 같은 값으로 비교되도록 소수 자리를 정규화한다.
        return format(value.normalize(), "f")
    if isinstance(value, uuid.UUID):
        return str(value)
    if hasattr(value, "value") and isinstance(value.value, str):  # StrEnum
        return value.value
    return value


def log_event(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    entity: str,
    entity_id: uuid.UUID,
    action: str,
    detail: dict[str, Any],
) -> None:
    """이력 한 줄을 세션에 더한다(호출한 서비스의 트랜잭션과 함께 커밋·롤백된다)."""
    session.add(
        RecordEvent(
            user_id=user_id,
            entity=entity,
            entity_id=entity_id,
            action=action,
            detail={key: _plain(value) for key, value in detail.items()},
        )
    )


def changes(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """바뀐 필드만 [이전, 이후] 로 모은다."""
    return {
        key: [_plain(before.get(key)), _plain(value)]
        for key, value in after.items()
        if _plain(before.get(key)) != _plain(value)
    }


async def bottle_history(
    session: AsyncSession, *, user_id: uuid.UUID, bottle_id: uuid.UUID
) -> list[dict[str, Any]]:
    """병의 상태 변경과 위치 이동을 최신순으로 합친다."""
    events = await session.scalars(
        select(RecordEvent).where(
            RecordEvent.user_id == user_id,
            RecordEvent.entity == "bottle",
            RecordEvent.entity_id == bottle_id,
        )
    )
    moves = await session.scalars(
        select(BottleMovement).where(
            BottleMovement.user_id == user_id, BottleMovement.bottle_id == bottle_id
        )
    )
    rows: list[dict[str, Any]] = [
        {"at": event.created_at, "action": event.action, "detail": event.detail} for event in events
    ]
    rows += [
        {
            "at": move.created_at,
            "action": "move",
            "detail": {
                "from_location_id": _plain(move.from_location_id),
                "to_location_id": _plain(move.to_location_id),
            },
        }
        for move in moves
    ]
    return sorted(rows, key=lambda row: row["at"], reverse=True)


async def entity_history(
    session: AsyncSession, *, user_id: uuid.UUID, entity: str, entity_id: uuid.UUID
) -> list[dict[str, Any]]:
    events = await session.scalars(
        select(RecordEvent)
        .where(
            RecordEvent.user_id == user_id,
            RecordEvent.entity == entity,
            RecordEvent.entity_id == entity_id,
        )
        .order_by(RecordEvent.created_at.desc())
    )
    return [
        {"at": event.created_at, "action": event.action, "detail": event.detail} for event in events
    ]
