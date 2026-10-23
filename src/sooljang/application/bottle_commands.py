"""행 잠금 안에서 병 revision과 원 명령을 검증하는 조건부 변경 규칙."""

import datetime
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError
from sooljang.application.history import changes, log_event
from sooljang.infrastructure.database.base import new_uuid
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    OutboxReceipt,
    TastingSession,
)

RESTORE_FIELDS = ("status", "opened_on", "finished_on", "remaining_ml", "note")


async def require_revision(
    session: AsyncSession,
    bottle: Bottle,
    *,
    expected_revision: uuid.UUID | None = None,
    expected_operation_id: uuid.UUID | None = None,
) -> None:
    """호출자는 병 행 잠금을 유지해야 한다. 직전 작업 참조는 서버 결과에만 연결한다."""
    if expected_operation_id is not None:
        receipt = await session.get(OutboxReceipt, expected_operation_id)
        effect = (
            receipt.response_snapshot.get("_effects", {}).get("bottle", {})
            if receipt is not None
            and receipt.user_id == bottle.user_id
            and receipt.status == "applied"
            else {}
        )
        if effect.get("id") != str(bottle.id) or effect.get("revision") != str(bottle.revision):
            raise ConflictError("이 병의 직전 변경을 확인할 수 없습니다. 최신 기록을 확인하세요")
    elif expected_revision is None:
        raise ConflictError(
            "변경 기준이 없는 이전 명령입니다. 최신 병 상태를 확인하고 다시 저장하세요"
        )
    if expected_revision is not None and expected_revision != bottle.revision:
        raise ConflictError("이 병에 후속 변경이 있습니다. 최신 기록을 확인하세요")


async def require_no_tasting(session: AsyncSession, bottle: Bottle) -> None:
    # 삭제된 시음도 실제 소비 사실을 되돌리지 않으므로 개봉 취소의 근거가 되지 않는다.
    tasting = await session.scalar(
        select(TastingSession.id).where(TastingSession.bottle_id == bottle.id).limit(1)
    )
    if tasting is not None:
        raise ConflictError("시음 기록이 있는 병은 개봉을 취소할 수 없습니다")


async def bottles_with_active_tastings(
    session: AsyncSession, bottle_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """호출자가 잠근 병 중 살아 있는 시음이 연결된 ID를 반환한다."""
    return {
        bottle_id
        for bottle_id in await session.scalars(
            select(TastingSession.bottle_id)
            .where(
                TastingSession.bottle_id.in_(bottle_ids),
                TastingSession.deleted_at.is_(None),
            )
            .distinct()
        )
        if bottle_id is not None
    }


async def delete_purchase_bottles(
    session: AsyncSession, purchase_id: uuid.UUID, *, now: datetime.datetime
) -> None:
    """구매 건 삭제에 딸린 병을 함께 soft delete 한다. 시음이 붙은 병이 있으면 거부한다.

    병만 지우면 남은 시음 기록이 삭제된 병을 가리켜 수정·삭제할 수 없는 고아가 된다.
    병 행을 먼저 잠가 같은 병에 동시에 들어오는 시음 기록과 순서를 정한다.
    """
    bottles = list(
        await session.scalars(
            select(Bottle)
            .where(Bottle.purchase_id == purchase_id, Bottle.deleted_at.is_(None))
            .order_by(Bottle.id)
            .with_for_update()
        )
    )
    if not bottles:
        return
    tasted = await bottles_with_active_tastings(session, [bottle.id for bottle in bottles])
    if tasted:
        raise ConflictError(
            f"시음 기록이 있는 병 {len(tasted)}개가 있어 구매 건을 삭제할 수 없습니다. "
            "시음 기록을 먼저 삭제하거나 구매 정보를 수정하세요"
        )
    for bottle in bottles:
        bottle.deleted_at = now


async def undo_bottle_command(
    session: AsyncSession, bottle: Bottle, *, origin_operation_id: uuid.UUID
) -> None:
    """원 명령의 직후 revision에서만 서버가 저장한 이전 상태로 복구한다."""
    receipt = await session.get(OutboxReceipt, origin_operation_id)
    if (
        receipt is None
        or receipt.user_id != bottle.user_id
        or receipt.entity != "bottle"
        or receipt.entity_id != bottle.id
        or receipt.operation != "action"
        or receipt.status != "applied"
    ):
        raise ConflictError("되돌릴 원래 변경을 확인할 수 없습니다")
    undo = receipt.response_snapshot.get("_undo", {})
    if undo.get("action") not in {
        "open",
        "finish",
        "gift",
        "sell",
        "set_remaining",
        "reopen",
        "unopen",
    }:
        raise ConflictError("이전 명령에는 안전하게 되돌릴 기록이 없습니다")
    if undo.get("after_revision") != str(bottle.revision):
        raise ConflictError("원래 변경 뒤에 이 병의 기록이 바뀌어 되돌릴 수 없습니다")
    before: dict[str, Any] = {name: getattr(bottle, name) for name in RESTORE_FIELDS}
    restored = undo["before"]
    for name in RESTORE_FIELDS:
        value = restored[name]
        if name in {"opened_on", "finished_on"} and value is not None:
            value = datetime.date.fromisoformat(value)
        elif name == "status":
            value = BottleStatus(value)
        setattr(bottle, name, value)
    bottle.revision = new_uuid()
    log_event(
        session,
        user_id=bottle.user_id,
        entity="bottle",
        entity_id=bottle.id,
        action="undo",
        detail={
            **changes(before, {name: getattr(bottle, name) for name in RESTORE_FIELDS}),
            "origin_operation_id": str(origin_operation_id),
        },
    )
    await session.flush()
