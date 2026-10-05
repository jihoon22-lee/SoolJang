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

from sooljang.infrastructure.database.models import (
    BottleMovement,
    RecordEvent,
    StorageLocation,
    Vendor,
)


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


#: 이력 detail 안에서 다른 기록을 id 로 가리키는 칸과 그 이름을 찾을 모델.
_REFERENCES: dict[str, type[Vendor] | type[StorageLocation]] = {
    "vendor_id": Vendor,
    "from_location_id": StorageLocation,
    "to_location_id": StorageLocation,
}


def _referenced_ids(detail: dict[str, Any], field: str) -> list[str]:
    value = detail.get(field)
    values = value if isinstance(value, list) else [value]
    return [item for item in values if isinstance(item, str)]


async def _with_labels(
    session: AsyncSession, user_id: uuid.UUID, rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """id 로 남은 구매처·보관 위치에 지금 이름을 붙인다.

    이력에는 id 만 저장한다(이름을 바꾸면 과거 이력도 새 이름으로 읽히는 편이 덜 헷갈린다).
    남의 기록 id 가 섞여 있어도 이름은 이 사용자 소유에서만 찾는다.
    """
    wanted: dict[type[Vendor] | type[StorageLocation], set[uuid.UUID]] = {}
    for row in rows:
        for field, model in _REFERENCES.items():
            for raw in _referenced_ids(row["detail"], field):
                try:
                    wanted.setdefault(model, set()).add(uuid.UUID(raw))
                except ValueError:
                    continue
    names: dict[str, str] = {}
    for model, ids in wanted.items():
        result = await session.execute(
            select(model.id, model.name).where(model.user_id == user_id, model.id.in_(ids))
        )
        names.update({str(row_id): name for row_id, name in result.tuples()})
    for row in rows:
        row["labels"] = {
            raw: names[raw]
            for field in _REFERENCES
            for raw in _referenced_ids(row["detail"], field)
            if raw in names
        }
    return rows


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
    rows.sort(key=lambda row: row["at"], reverse=True)
    return await _with_labels(session, user_id, rows)


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
    rows = [
        {"at": event.created_at, "action": event.action, "detail": event.detail} for event in events
    ]
    return await _with_labels(session, user_id, rows)
