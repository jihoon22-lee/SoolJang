"""병 상태 전이와 시음 세션 라우터.

상태 전이를 `PATCH /bottles/{id}` 로 필드 갱신하게 두지 않고 `:open` 같은 동작
엔드포인트로 노출한다. 상태·잔량·날짜가 서로 얽혀 있어 필드를 개별로 쓰게 하면 어긋난 조합이
저장된다.
"""

import datetime
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query, status
from sqlalchemy import select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.api.pagination import Cursor, build_page
from sooljang.api.schemas.tasting import (
    BottleOut,
    BottleRevisionRequest,
    FinishBottleRequest,
    HandOverRequest,
    OpenBottleRequest,
    SetRemainingRequest,
    TastingCreate,
    TastingOut,
    TastingPageOut,
    TastingSummaryOut,
)
from sooljang.application.bottle_commands import require_no_tasting, require_revision
from sooljang.application.history import bottle_history
from sooljang.application.tastings import (
    BottleTransitionError,
    InsufficientRemainingError,
    InvalidRatingError,
    TastingInput,
    finish_bottle,
    hand_over_bottle,
    list_tastings,
    load_bottle_for_write,
    open_bottle,
    record_tasting,
    reopen_bottle,
    set_remaining,
    summarize_tastings,
    unopen_bottle,
)
from sooljang.infrastructure.database.models import Bottle, BottleStatus, Purchase, Sku

bottles_router = APIRouter(prefix="/bottles", tags=["bottles"])
tastings_router = APIRouter(prefix="/tastings", tags=["tastings"])


async def _get_bottle(
    session: SessionDep, user_id: uuid.UUID, bottle_id: uuid.UUID, *, for_update: bool = False
) -> Bottle:
    if for_update:
        record = await load_bottle_for_write(session, user_id=user_id, bottle_id=bottle_id)
    else:
        record = await session.scalar(
            select(Bottle).where(
                Bottle.id == bottle_id,
                Bottle.user_id == user_id,
                Bottle.deleted_at.is_(None),
            )
        )
    if record is None:
        raise NotFoundError("병을 찾을 수 없습니다")
    return record


@bottles_router.get("", response_model=list[BottleOut], summary="병 목록")
async def list_bottles(
    session: SessionDep,
    user_id: UserDep,
    bottle_status: Annotated[BottleStatus | None, Query(alias="status")] = None,
    in_stock: Annotated[bool | None, Query(description="true 면 미개봉·개봉만")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0, description="이전 페이지까지 받은 개수")] = 0,
) -> list[BottleOut]:
    """병 목록. 상태로 필터할 수 있다. 500병을 넘으면 offset 으로 이어 받는다."""
    filters = [Bottle.user_id == user_id, Bottle.deleted_at.is_(None)]
    if bottle_status is not None:
        filters.append(Bottle.status == bottle_status)
    if in_stock is True:
        filters.append(Bottle.status.in_([BottleStatus.UNOPENED, BottleStatus.OPEN]))
    elif in_stock is False:
        filters.append(Bottle.status.not_in([BottleStatus.UNOPENED, BottleStatus.OPEN]))

    records = await session.scalars(
        select(Bottle)
        .where(*filters)
        .order_by(Bottle.created_at.desc(), Bottle.id.desc())
        .offset(offset)
        .limit(limit)
    )
    return [BottleOut.model_validate(record) for record in records]


@bottles_router.get("/{bottle_id}", response_model=BottleOut, summary="병 조회")
async def get_bottle(session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID) -> BottleOut:
    return BottleOut.model_validate(await _get_bottle(session, user_id, bottle_id))


@bottles_router.post("/{bottle_id}:open", response_model=BottleOut, summary="개봉")
async def open_bottle_endpoint(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID, payload: OpenBottleRequest
) -> BottleOut:
    record = await _get_bottle(session, user_id, bottle_id, for_update=True)
    try:
        await open_bottle(
            session,
            record,
            opened_on=payload.opened_on,
            remaining_ml=payload.remaining_ml,
        )
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error
    await session.refresh(record)
    return BottleOut.model_validate(record)


@bottles_router.post("/{bottle_id}:finish", response_model=BottleOut, summary="소진")
async def finish_bottle_endpoint(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID, payload: FinishBottleRequest
) -> BottleOut:
    record = await _get_bottle(session, user_id, bottle_id, for_update=True)
    try:
        await finish_bottle(session, record, finished_on=payload.finished_on)
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error
    await session.refresh(record)
    return BottleOut.model_validate(record)


@bottles_router.post("/{bottle_id}:gift", response_model=BottleOut, summary="증여")
async def gift_bottle_endpoint(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID, payload: HandOverRequest
) -> BottleOut:
    return await _hand_over(session, user_id, bottle_id, payload, BottleStatus.GIFTED)


@bottles_router.post("/{bottle_id}:sell", response_model=BottleOut, summary="판매")
async def sell_bottle_endpoint(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID, payload: HandOverRequest
) -> BottleOut:
    return await _hand_over(session, user_id, bottle_id, payload, BottleStatus.SOLD)


async def _hand_over(
    session: SessionDep,
    user_id: uuid.UUID,
    bottle_id: uuid.UUID,
    payload: HandOverRequest,
    new_status: BottleStatus,
) -> BottleOut:
    record = await _get_bottle(session, user_id, bottle_id, for_update=True)
    try:
        await hand_over_bottle(session, record, status=new_status, note=payload.note, on=payload.on)
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error
    await session.refresh(record)
    return BottleOut.model_validate(record)


@bottles_router.post("/{bottle_id}:reopen", response_model=BottleOut, summary="상태 되돌리기")
async def reopen_bottle_endpoint(
    session: SessionDep,
    user_id: UserDep,
    bottle_id: uuid.UUID,
    payload: BottleRevisionRequest | None = None,
) -> BottleOut:
    """잘못 누른 경우를 위한 되돌리기. 기록을 지우지 않고 상태만 개봉으로 바꾼다."""
    record = await _get_bottle(session, user_id, bottle_id, for_update=True)
    guard = payload or BottleRevisionRequest()
    await require_revision(session, record, **guard.model_dump())
    try:
        await reopen_bottle(session, record)
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error
    await session.refresh(record)
    return BottleOut.model_validate(record)


@bottles_router.post("/{bottle_id}:remaining", response_model=BottleOut, summary="잔량 조정")
async def set_remaining_endpoint(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID, payload: SetRemainingRequest
) -> BottleOut:
    """개봉 병의 잔량을 직접 맞춘다. 0 이면 소진 처리한다."""
    record = await _get_bottle(session, user_id, bottle_id, for_update=True)
    await require_revision(
        session,
        record,
        expected_revision=payload.expected_revision,
        expected_operation_id=payload.expected_operation_id,
    )
    try:
        await set_remaining(session, record, remaining_ml=payload.remaining_ml, on=payload.on)
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error
    await session.refresh(record)
    return BottleOut.model_validate(record)


@bottles_router.post("/{bottle_id}:unopen", response_model=BottleOut, summary="개봉 취소")
async def unopen_bottle_endpoint(
    session: SessionDep,
    user_id: UserDep,
    bottle_id: uuid.UUID,
    payload: BottleRevisionRequest | None = None,
) -> BottleOut:
    """실수로 개봉을 누른 경우를 위한 되돌리기. 개봉 상태만 미개봉으로 되돌릴 수 있다."""
    record = await _get_bottle(session, user_id, bottle_id, for_update=True)
    guard = payload or BottleRevisionRequest()
    await require_revision(session, record, **guard.model_dump())
    await require_no_tasting(session, record)
    try:
        await unopen_bottle(session, record)
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error
    await session.refresh(record)
    return BottleOut.model_validate(record)


@bottles_router.get("/{bottle_id}/history", summary="병 변경 이력")
async def bottle_history_endpoint(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID
) -> list[dict[str, Any]]:
    """상태 전이·잔량 조정·시음으로 인한 변화와 위치 이동을 최신순으로 합쳐 돌려준다."""
    await _get_bottle(session, user_id, bottle_id)
    return await bottle_history(session, user_id=user_id, bottle_id=bottle_id)


@bottles_router.get(
    "/{bottle_id}/tastings", response_model=list[TastingOut], summary="병의 시음 타임라인"
)
async def bottle_tastings(
    session: SessionDep, user_id: UserDep, bottle_id: uuid.UUID
) -> list[TastingOut]:
    await _get_bottle(session, user_id, bottle_id)
    records = await list_tastings(session, user_id=user_id, bottle_id=bottle_id)
    return [TastingOut.model_validate(record) for record in records]


@bottles_router.get(
    "/{bottle_id}/tastings/page", response_model=TastingPageOut, summary="병의 시음 내역 이어 보기"
)
async def bottle_tastings_page(
    session: SessionDep,
    user_id: UserDep,
    bottle_id: uuid.UUID,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: Annotated[str | None, Query(max_length=2048)] = None,
) -> TastingPageOut:
    await _get_bottle(session, user_id, bottle_id)
    before = None
    if cursor is not None:
        decoded = Cursor.decode(cursor)
        try:
            if not isinstance(decoded.sort_value, str):
                raise ValueError("날짜가 아닙니다")
            before = (datetime.date.fromisoformat(decoded.sort_value), decoded.id)
        except ValueError as error:
            raise ValidationFailedError("시음 내역 cursor의 날짜를 해석할 수 없습니다") from error
    records = await list_tastings(
        session, user_id=user_id, bottle_id=bottle_id, limit=limit + 1, before=before
    )
    page = build_page(
        records, limit=limit, sort_value_of=lambda row: row.tasted_on, id_of=lambda row: row.id
    )
    return TastingPageOut(
        items=[TastingOut.model_validate(record) for record in page.items],
        next_cursor=page.next_cursor,
    )


@tastings_router.post(
    "", response_model=TastingOut, status_code=status.HTTP_201_CREATED, summary="시음 기록"
)
async def create_tasting(
    session: SessionDep, user_id: UserDep, payload: TastingCreate
) -> TastingOut:
    """시음을 기록한다.

    병을 지정하면 잔량을 차감하고, 미개봉 병이면 자동으로 개봉 처리한다. 마시기 시작한 것
    자체가 개봉이므로 따로 버튼을 누르게 하면 잊어버린다.
    """
    bottle = None
    sku_id = payload.sku_id

    if payload.bottle_id is not None:
        bottle = await _get_bottle(session, user_id, payload.bottle_id, for_update=True)
        purchase = await session.get(Purchase, bottle.purchase_id)
        if purchase is None:
            raise NotFoundError("병에 연결된 구매 건을 찾을 수 없습니다")
        sku_id = purchase.sku_id

    if sku_id is None:
        raise ValidationFailedError("bottle_id 또는 sku_id 중 하나는 있어야 합니다")
    if bottle is None:
        owned_sku = await session.scalar(
            select(Sku.id).where(Sku.id == sku_id, Sku.user_id == user_id, Sku.deleted_at.is_(None))
        )
        if owned_sku is None:
            raise NotFoundError(f"규격을 찾을 수 없습니다: {sku_id}")

    try:
        record = await record_tasting(
            session,
            user_id=user_id,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(
                tasted_on=payload.tasted_on,
                poured_ml=payload.poured_ml,
                rating=payload.rating,
                nose=payload.nose,
                palate=payload.palate,
                finish=payload.finish,
                note=payload.note,
                place=payload.place,
                companions=payload.companions,
            ),
        )
    except InsufficientRemainingError as error:
        raise ConflictError(str(error)) from error
    except InvalidRatingError as error:
        raise ValidationFailedError(str(error)) from error
    except BottleTransitionError as error:
        raise ConflictError(str(error)) from error

    await session.refresh(record)
    return TastingOut.model_validate(record)


@tastings_router.get("", response_model=list[TastingOut], summary="시음 타임라인")
async def timeline(
    session: SessionDep,
    user_id: UserDep,
    sku_id: Annotated[uuid.UUID | None, Query()] = None,
    bottle_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[TastingOut]:
    records = await list_tastings(
        session, user_id=user_id, sku_id=sku_id, bottle_id=bottle_id, limit=limit
    )
    return [TastingOut.model_validate(record) for record in records]


@tastings_router.get("/summary", response_model=TastingSummaryOut, summary="시음 요약")
async def summary(
    session: SessionDep,
    user_id: UserDep,
    sku_id: Annotated[uuid.UUID | None, Query()] = None,
    bottle_id: Annotated[uuid.UUID | None, Query()] = None,
) -> TastingSummaryOut:
    """시음 요약. 기록이 없어도 404 가 아니라 0 과 null 을 반환한다(정상 상태)."""
    result = await summarize_tastings(session, user_id=user_id, sku_id=sku_id, bottle_id=bottle_id)
    return TastingSummaryOut(
        session_count=result.session_count,
        rated_count=result.rated_count,
        average_rating=result.average_rating,
        first_rating=result.first_rating,
        latest_rating=result.latest_rating,
        rating_change=result.rating_change,
        total_poured_ml=result.total_poured_ml,
        first_tasted_on=result.first_tasted_on,
        latest_tasted_on=result.latest_tasted_on,
    )


@tastings_router.delete(
    "/{tasting_id}", status_code=status.HTTP_204_NO_CONTENT, summary="시음 기록 삭제"
)
async def delete_tasting(session: SessionDep, user_id: UserDep, tasting_id: uuid.UUID) -> None:
    """시음 기록을 지운다.

    잔량은 되돌리지 않는다. 실제로 마신 양을 되돌릴 방법이 없고, 잘못 입력했다면 병의 잔량을
    직접 고치는 편이 명확하다.
    """
    from sooljang.infrastructure.database.models import TastingSession

    record = await session.scalar(
        select(TastingSession).where(
            TastingSession.id == tasting_id,
            TastingSession.user_id == user_id,
            TastingSession.deleted_at.is_(None),
        )
    )
    if record is None:
        raise NotFoundError("시음 기록을 찾을 수 없습니다")

    import datetime

    record.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()
