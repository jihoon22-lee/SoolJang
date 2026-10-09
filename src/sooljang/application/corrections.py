"""현재 상태를 명시하여 기록 연결을 정정하는 트랜잭션."""

import datetime
import hashlib
import json
import uuid
from typing import Any

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.api.schemas.corrections import (
    ContextualTasting,
    FinalBottleState,
    PurchaseCorrectionContext,
    PurchaseSkuCorrection,
    TastingCorrection,
)
from sooljang.application.history import log_event
from sooljang.application.tasting_context import (
    columns,
    contextual_tastings,
    correction_purchase_context,
    owned_tasting,
)
from sooljang.application.tastings import InvalidRatingError, validate_rating
from sooljang.application.write_locks import lock_user_writes
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    OutboxReceipt,
    Product,
    Purchase,
    Sku,
    TastingSession,
)


def _fingerprint(payload: BaseModel) -> str:
    # 변경 필드의 생략은 보존, 명시적 null은 초기화다. 중첩 모델의 필드 존재 여부도
    # 해시에 남겨 두 요청을 같은 재전송으로 해석하지 않는다.
    return hashlib.sha256(
        json.dumps(
            payload.model_dump(mode="json", exclude_unset=True),
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


async def _receipt(
    session: AsyncSession,
    user_id: uuid.UUID,
    entity: str,
    entity_id: uuid.UUID,
    action: str,
    payload: Any,
) -> dict[str, Any] | None:
    await lock_user_writes(session, user_id)
    key = int.from_bytes(
        hashlib.blake2b(payload.request_id.bytes, digest_size=8).digest(), signed=True
    )
    await session.execute(select(func.pg_advisory_xact_lock(key)))
    receipt = await session.get(OutboxReceipt, payload.request_id)
    if receipt is None:
        return None
    if (
        receipt.user_id != user_id
        or receipt.entity != entity
        or receipt.entity_id != entity_id
        or receipt.operation != action
        or receipt.response_snapshot.get("_request_hash") != _fingerprint(payload)
    ):
        raise ConflictError("다른 요청에 사용된 request_id입니다")
    if receipt.created_at < datetime.datetime.now(datetime.UTC) - datetime.timedelta(
        days=30
    ) or receipt.response_snapshot.get("receipt_expired"):
        raise ConflictError("정정 재시도 보관 기간이 지났습니다. 최신 기록을 확인하세요")
    return receipt.response_snapshot["_response"]


def _save_receipt(
    session: AsyncSession,
    user_id: uuid.UUID,
    entity: str,
    entity_id: uuid.UUID,
    action: str,
    payload: Any,
    response: BaseModel,
) -> None:
    session.add(
        OutboxReceipt(
            id=payload.request_id,
            user_id=user_id,
            entity=entity,
            entity_id=entity_id,
            operation=action,
            status="applied",
            response_snapshot={
                "_request_hash": _fingerprint(payload),
                "_response": response.model_dump(mode="json"),
            },
        )
    )


async def _lock_rows(
    session: AsyncSession, model: Any, ids: set[uuid.UUID], user_id: uuid.UUID, *, live: bool = True
) -> dict[uuid.UUID, Any]:
    rows = list(
        await session.scalars(
            select(model)
            .where(model.id.in_(ids), model.user_id == user_id)
            .order_by(model.id)
            .with_for_update(key_share=model in (Product, Sku, Purchase))
            .execution_options(populate_existing=True)
        )
    )
    if len(rows) != len(ids) or (live and any(r.deleted_at is not None for r in rows)):
        raise NotFoundError("정정 대상을 찾을 수 없습니다")
    return {r.id: r for r in rows}


async def _lock_graph(
    session: AsyncSession,
    user_id: uuid.UUID,
    sku_ids: set[uuid.UUID],
    purchase_ids: set[uuid.UUID],
    bottle_ids: set[uuid.UUID],
    tasting_ids: set[uuid.UUID],
    *,
    deleted_children: bool = False,
) -> tuple[dict[uuid.UUID, Any], dict[uuid.UUID, Any], dict[uuid.UUID, Any], dict[uuid.UUID, Any]]:
    initial_skus = dict(
        (
            await session.execute(
                select(Sku.id, Sku.product_id).where(Sku.id.in_(sku_ids), Sku.user_id == user_id)
            )
        )
        .tuples()
        .all()
    )
    if set(initial_skus) != sku_ids:
        raise NotFoundError("규격을 찾을 수 없습니다")
    await _lock_rows(session, Product, set(initial_skus.values()), user_id)
    skus = await _lock_rows(session, Sku, sku_ids, user_id)
    if any(skus[k].product_id != v for k, v in initial_skus.items()):
        raise ConflictError("규격 연결이 변경되었습니다")
    purchases = await _lock_rows(session, Purchase, purchase_ids, user_id)
    bottles = await _lock_rows(session, Bottle, bottle_ids, user_id, live=not deleted_children)
    tastings = await _lock_rows(
        session, TastingSession, tasting_ids, user_id, live=not deleted_children
    )
    return skus, purchases, bottles, tastings


def _unique(items: list[Any]) -> dict[uuid.UUID, Any]:
    result = {item.id: item for item in items}
    if len(result) != len(items):
        raise ValidationFailedError("같은 기록을 중복 지정할 수 없습니다")
    return result


def _guard_rows(rows: dict[uuid.UUID, Any], guards: list[Any], field: str) -> None:
    mapped = _unique(guards)
    if set(mapped) != set(rows) or any(
        getattr(rows[key], field) != getattr(value, field) for key, value in mapped.items()
    ):
        raise ConflictError("관련 기록이 변경되었습니다. 최신 기록을 확인하세요")


def _final_state(bottle: Bottle, state: FinalBottleState, volume: int) -> None:
    if state.remaining_ml is not None and state.remaining_ml > volume:
        raise ValidationFailedError("잔량은 규격 용량을 넘을 수 없습니다")
    if state.opened_on and state.finished_on and state.finished_on < state.opened_on:
        raise ValidationFailedError("종료일은 개봉일보다 빠를 수 없습니다")
    if state.status == "unopened" and (
        state.opened_on is not None
        or state.finished_on is not None
        or state.remaining_ml not in (None, volume)
    ):
        raise ValidationFailedError("미개봉 병은 개봉·종료일이 없고 전량이어야 합니다")
    if state.status == "open" and (state.finished_on is not None or state.remaining_ml == 0):
        raise ValidationFailedError("개봉 병의 종료일·잔량을 확인하세요")
    if state.status == "finished" and state.remaining_ml != 0:
        raise ValidationFailedError("소진 병의 잔량은 0이어야 합니다")
    bottle.status = BottleStatus(state.status)
    bottle.remaining_ml = state.remaining_ml
    bottle.opened_on = state.opened_on
    bottle.finished_on = state.finished_on


def _validate_tasting_date(tasted_on: datetime.date, state: Bottle | FinalBottleState) -> None:
    """알려진 개봉·종료일만 비교하고 미기록 날짜를 추측하거나 자동 보정하지 않는다."""
    if state.opened_on is not None and tasted_on < state.opened_on:
        raise ValidationFailedError(
            "시음일이 대상 병의 개봉일보다 빠릅니다. 시음일 또는 최종 개봉일을 확인하세요"
        )
    if state.finished_on is not None and tasted_on > state.finished_on:
        raise ValidationFailedError(
            "시음일이 대상 병의 소진·처분일보다 늦습니다. 시음일 또는 최종 종료일을 확인하세요"
        )


def _audit(
    session: AsyncSession,
    user_id: uuid.UUID,
    entity: str,
    row: Any,
    request_id: uuid.UUID,
    before: dict[str, Any],
) -> None:
    # Nested audit values are converted together; private notes stay in DB, never logs.
    detail = json.loads(
        json.dumps(
            {"request_id": str(request_id), "before": before, "after": columns(row)}, default=str
        )
    )
    log_event(
        session, user_id=user_id, entity=entity, entity_id=row.id, action="correct", detail=detail
    )


async def correct_tasting(
    session: AsyncSession, user_id: uuid.UUID, tasting_id: uuid.UUID, payload: TastingCorrection
) -> ContextualTasting:
    replay = await _receipt(session, user_id, "tasting_session", tasting_id, "correct", payload)
    if replay is not None:
        return ContextualTasting.model_validate(replay)
    initial = await owned_tasting(session, user_id, tasting_id)
    original = (initial.sku_id, initial.bottle_id)
    changes = payload.changes.model_dump(exclude_unset=True)
    if changes.get("tasted_on", initial.tasted_on) is None or (
        "sku_id" in changes and changes["sku_id"] is None
    ):
        raise ValidationFailedError("규격과 시음일은 비울 수 없습니다")
    if "bottle_id" in changes and changes["bottle_id"] is None and not changes.get("sku_id"):
        raise ValidationFailedError("병 없는 시음은 규격을 지정해야 합니다")
    target_bottle_id = changes.get("bottle_id", initial.bottle_id)
    bottle_ids = {x for x in (initial.bottle_id, target_bottle_id) if x is not None}
    initial_bottles = dict(
        (
            await session.execute(
                select(Bottle.id, Bottle.purchase_id).where(
                    Bottle.id.in_(bottle_ids), Bottle.user_id == user_id
                )
            )
        )
        .tuples()
        .all()
    )
    if set(initial_bottles) != bottle_ids:
        raise NotFoundError("병을 찾을 수 없습니다")
    initial_purchases = dict(
        (
            await session.execute(
                select(Purchase.id, Purchase.sku_id).where(
                    Purchase.id.in_(set(initial_bottles.values())), Purchase.user_id == user_id
                )
            )
        )
        .tuples()
        .all()
    )
    if set(initial_purchases) != set(initial_bottles.values()):
        raise NotFoundError("구매 건을 찾을 수 없습니다")
    target_sku_id = (
        initial_purchases[initial_bottles[target_bottle_id]]
        if target_bottle_id
        else changes.get("sku_id", initial.sku_id)
    )
    if target_bottle_id and "sku_id" in changes and changes["sku_id"] != target_sku_id:
        raise ValidationFailedError("대상 병과 규격이 일치하지 않습니다")
    skus, purchases, bottles, tastings = await _lock_graph(
        session,
        user_id,
        {initial.sku_id, target_sku_id, *initial_purchases.values()},
        set(initial_purchases),
        bottle_ids,
        {tasting_id},
    )
    record = tastings[tasting_id]
    if (
        (record.sku_id, record.bottle_id) != original
        or any(bottles[k].purchase_id != v for k, v in initial_bottles.items())
        or any(purchases[k].sku_id != v for k, v in initial_purchases.items())
    ):
        raise ConflictError("기록의 연결이 변경되었습니다")
    if record.updated_at != payload.expected_updated_at:
        raise ConflictError("시음 기록이 변경되었습니다")
    _guard_rows(bottles, payload.expected_bottles, "revision")
    if (
        target_bottle_id is None
        and skus[target_sku_id].volume_ml != payload.target_sku_expected_volume_ml
    ):
        raise ConflictError("대상 규격 용량이 변경되었습니다. 최신 규격을 확인하세요")
    finals = _unique(payload.final_bottles)
    if (payload.remaining_mode == "preserve" and finals) or (
        payload.remaining_mode == "set_final" and set(finals) != bottle_ids
    ):
        raise ValidationFailedError("영향받는 병의 최종 상태를 정확히 지정하세요")
    tasted_on = changes.get("tasted_on", record.tasted_on)
    # 과거의 날짜 불일치는 내용만 수정할 때 보존한다. 폼이 같은 날짜/대상을 다시
    # 보내도 새 변경으로 보지 않으며, 최종 상태를 명시하면 적용할 날짜로 검증한다.
    if target_bottle_id is not None and (
        tasted_on != record.tasted_on
        or target_bottle_id != record.bottle_id
        or payload.remaining_mode == "set_final"
    ):
        _validate_tasting_date(tasted_on, finals.get(target_bottle_id) or bottles[target_bottle_id])
    try:
        validate_rating(changes.get("rating", record.rating))
    except InvalidRatingError as error:
        raise ValidationFailedError(str(error)) from error
    before = columns(record)
    for key, value in changes.items():
        setattr(record, key, value)
    record.sku_id = target_sku_id
    record.bottle_id = target_bottle_id
    record.updated_at = datetime.datetime.now(datetime.UTC)
    for bottle in bottles.values():
        old = columns(bottle)
        if bottle.id in finals:
            _final_state(
                bottle, finals[bottle.id], skus[purchases[bottle.purchase_id].sku_id].volume_ml
            )
        bottle.revision = uuid.uuid4()
        _audit(session, user_id, "bottle", bottle, payload.request_id, old)
    _audit(session, user_id, "tasting_session", record, payload.request_id, before)
    await session.flush()
    await session.refresh(record)
    response = ContextualTasting.model_validate(
        (await contextual_tastings(session, user_id, [record]))[0]
    )
    _save_receipt(session, user_id, "tasting_session", tasting_id, "correct", payload, response)
    await session.flush()
    return response


async def correct_purchase_sku(
    session: AsyncSession,
    user_id: uuid.UUID,
    purchase_id: uuid.UUID,
    payload: PurchaseSkuCorrection,
) -> PurchaseCorrectionContext:
    replay = await _receipt(session, user_id, "purchase", purchase_id, "correct_sku", payload)
    if replay is not None:
        return PurchaseCorrectionContext.model_validate(replay)
    initial = await correction_purchase_context(session, user_id, purchase_id)
    original_sku = initial["purchase"]["sku_id"]
    bottle_ids = {b["id"] for b in initial["bottles"]}
    tasting_ids = {t["id"] for t in initial["tastings"]}
    skus, purchases, bottles, tastings = await _lock_graph(
        session,
        user_id,
        {original_sku, payload.target_sku_id},
        {purchase_id},
        bottle_ids,
        tasting_ids,
        deleted_children=True,
    )
    purchase = purchases[purchase_id]
    if (
        purchase.sku_id != original_sku
        or any(b.purchase_id != purchase_id for b in bottles.values())
        or any(t.bottle_id not in bottle_ids for t in tastings.values())
    ):
        raise ConflictError("구매 연결이 변경되었습니다")
    # A split can create/remove children while waiting on the purchase lock.
    current_bottles = set(
        await session.scalars(
            select(Bottle.id).where(Bottle.purchase_id == purchase_id, Bottle.user_id == user_id)
        )
    )
    current_tastings = set(
        await session.scalars(
            select(TastingSession.id).where(
                TastingSession.bottle_id.in_(current_bottles), TastingSession.user_id == user_id
            )
        )
    )
    if (
        current_bottles != bottle_ids
        or current_tastings != tasting_ids
        or purchase.updated_at != payload.expected_updated_at
    ):
        raise ConflictError("구매 또는 연결 기록이 변경되었습니다")
    _guard_rows(bottles, payload.expected_bottles, "revision")
    _guard_rows(tastings, payload.expected_tastings, "updated_at")
    target = skus[payload.target_sku_id]
    if target.product_id != skus[original_sku].product_id:
        raise ValidationFailedError("같은 제품의 규격만 선택할 수 있습니다")
    if target.volume_ml != payload.target_sku_expected_volume_ml:
        raise ConflictError("대상 규격 용량이 변경되었습니다")
    finals = _unique(payload.final_bottles)
    if not set(finals) <= bottle_ids:
        raise ValidationFailedError("이 구매의 병만 지정할 수 있습니다")
    before = columns(purchase)
    purchase.sku_id = target.id
    purchase.updated_at = datetime.datetime.now(datetime.UTC)
    for bottle in bottles.values():
        old = columns(bottle)
        if bottle.id in finals:
            _final_state(bottle, finals[bottle.id], target.volume_ml)
        elif bottle.remaining_ml is not None and bottle.remaining_ml > target.volume_ml:
            raise ValidationFailedError("새 규격 용량을 넘는 병의 최종 잔량을 지정하세요")
        bottle.revision = uuid.uuid4()
        _audit(session, user_id, "bottle", bottle, payload.request_id, old)
    for tasting in tastings.values():
        old = columns(tasting)
        tasting.sku_id = target.id
        tasting.updated_at = datetime.datetime.now(datetime.UTC)
        _audit(session, user_id, "tasting_session", tasting, payload.request_id, old)
    _audit(session, user_id, "purchase", purchase, payload.request_id, before)
    await session.flush()
    response = PurchaseCorrectionContext.model_validate(
        await correction_purchase_context(session, user_id, purchase_id)
    )
    _save_receipt(session, user_id, "purchase", purchase_id, "correct_sku", payload, response)
    await session.flush()
    return response
