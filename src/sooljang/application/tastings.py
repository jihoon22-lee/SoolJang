"""병 상태 전이와 시음 세션 서비스.

상태 전이를 서비스에 모으는 이유는, 상태와 잔량과 날짜가 서로 얽혀 있어서다. 개봉하면
`status`·`opened_on`·`remaining_ml` 이 함께 바뀌고, 소진하면 `finished_on` 과 잔량 0 이
함께 성립해야 한다. 라우터가 필드를 개별로 쓰게 두면 어긋난 조합이 조용히 저장된다.
"""

import datetime
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.history import changes, log_event
from sooljang.clock import local_today
from sooljang.infrastructure.database.base import new_uuid
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Product,
    Purchase,
    Sku,
    TastingSession,
)

#: 재고로 세는 상태. 증여·판매·소진은 재고가 아니다.
OPEN_STATUSES = frozenset({BottleStatus.OPEN})


class BottleTransitionError(Exception):
    """허용되지 않는 상태 전이."""


class BottleInputError(BottleTransitionError):
    """병의 현재 상태와 무관하게 입력 자체가 틀렸다(날짜 순서·잔량 범위).

    동기화는 상태가 어긋난 전이를 다른 기기와의 충돌로 다루지만, 이 오류는 사용자가 고쳐서
    다시 보내야 하는 실패다(`application/sync.py`).
    """


class InsufficientRemainingError(Exception):
    """잔량보다 많이 따르려 했다."""

    def __init__(self, remaining_ml: int, requested_ml: int) -> None:
        super().__init__(
            f"잔량이 부족합니다. 남은 양 {remaining_ml}ml, 따르려는 양 {requested_ml}ml"
        )
        self.remaining_ml = remaining_ml
        self.requested_ml = requested_ml


class InvalidRatingError(ValueError):
    """평점이 척도를 벗어났다."""


def validate_rating(rating: Decimal | None) -> Decimal | None:
    """평점을 검증한다.

    레거시 시트 실측 결과 **6점 만점 0.5 단위**였다. 3.7 같은 값을 받으면 엑셀 통계와 대조할
    수 없으므로 입력 시점에 막는다.
    """
    if rating is None:
        return None
    if rating < 0 or rating > Decimal("6.0"):
        raise InvalidRatingError("평점은 0 이상 6.0 이하여야 합니다")
    if (rating * 2) % 1 != 0:
        raise InvalidRatingError("평점은 0.5 단위여야 합니다")
    return rating


def _state(bottle: Bottle) -> dict[str, Any]:
    return {
        "status": bottle.status,
        "opened_on": bottle.opened_on,
        "finished_on": bottle.finished_on,
        "remaining_ml": bottle.remaining_ml,
    }


def _log_transition(
    session: AsyncSession, bottle: Bottle, action: str, before: dict[str, Any], **extra: Any
) -> None:
    """상태 전이 이력. 바뀐 칸만 [이전, 이후] 로 남긴다(병 위치 이동은 `BottleMovement`)."""
    bottle.revision = new_uuid()
    log_event(
        session,
        user_id=bottle.user_id,
        entity="bottle",
        entity_id=bottle.id,
        action=action,
        detail={**changes(before, _state(bottle)), **extra},
    )


def live_bottles_query(user_id: uuid.UUID) -> Select[tuple[Bottle]]:
    """예전 버전의 부모만 삭제된 행도 원본은 보존하고 정상 조회·쓰기에서는 제외한다."""
    return (
        select(Bottle)
        .join(Purchase, Purchase.id == Bottle.purchase_id)
        .join(Sku, Sku.id == Purchase.sku_id)
        .join(Product, Product.id == Sku.product_id)
        .where(
            Bottle.user_id == user_id,
            Bottle.deleted_at.is_(None),
            Purchase.user_id == user_id,
            Purchase.deleted_at.is_(None),
            Sku.user_id == user_id,
            Sku.deleted_at.is_(None),
            Product.user_id == user_id,
            Product.deleted_at.is_(None),
        )
    )


async def load_bottle_for_write(
    session: AsyncSession, *, user_id: uuid.UUID, bottle_id: uuid.UUID
) -> Bottle | None:
    """온라인·outbox가 상태/잔량을 읽기 전에 같은 행 잠금을 얻는다."""
    return await session.scalar(
        live_bottles_query(user_id)
        .where(Bottle.id == bottle_id)
        .with_for_update(of=Bottle)
        .execution_options(populate_existing=True)
    )


async def _sku_volume_ml(session: AsyncSession, sku_id: uuid.UUID) -> int | None:
    """규격 용량. 개봉 시 잔량 초기값으로 쓴다."""
    return await session.scalar(select(Sku.volume_ml).where(Sku.id == sku_id))


async def _bottle_volume_ml(session: AsyncSession, bottle: Bottle) -> int | None:
    sku_id = await session.scalar(select(Purchase.sku_id).where(Purchase.id == bottle.purchase_id))
    if sku_id is None:
        return None
    return await _sku_volume_ml(session, sku_id)


async def open_bottle(
    session: AsyncSession,
    bottle: Bottle,
    *,
    opened_on: datetime.date | None = None,
    remaining_ml: int | None = None,
    log: bool = True,
) -> Bottle:
    """병을 개봉한다.

    잔량을 지정하지 않으면 규격 용량 전량으로 초기화한다. 개봉 직후 잔량은 용량과 같다.
    """
    if bottle.status != BottleStatus.UNOPENED:
        raise BottleTransitionError(f"미개봉 병만 개봉할 수 있습니다 (현재 상태: {bottle.status})")

    volume = await _bottle_volume_ml(session, bottle)
    if remaining_ml is not None:
        # 0ml 로 열면 열린 채 영구 재고로 남고, 용량보다 많으면 이후 따르기·통계가 틀린다.
        if remaining_ml <= 0:
            raise BottleInputError("개봉 잔량은 0보다 커야 합니다. 비었다면 소진으로 기록하세요")
        if volume is not None and remaining_ml > volume:
            raise BottleInputError(f"잔량이 병 용량({volume}ml)보다 클 수 없습니다")

    before = _state(bottle)
    bottle.status = BottleStatus.OPEN
    bottle.opened_on = opened_on or local_today()
    bottle.remaining_ml = remaining_ml if remaining_ml is not None else volume
    if log:
        _log_transition(session, bottle, "open", before)
    await session.flush()
    return bottle


async def finish_bottle(
    session: AsyncSession, bottle: Bottle, *, finished_on: datetime.date | None = None
) -> Bottle:
    """병을 소진 처리한다.

    미개봉 병을 바로 소진할 수도 있게 둔다. 개봉일을 기록하지 않고 마셔 버린 뒤 나중에 정리하는
    일이 흔하다. 그 경우 개봉일을 소진일과 같게 채운다.
    """
    if bottle.status in {BottleStatus.GIFTED, BottleStatus.SOLD}:
        raise BottleTransitionError(
            f"이미 내보낸 병은 소진할 수 없습니다 (현재 상태: {bottle.status})"
        )
    if bottle.status == BottleStatus.FINISHED:
        raise BottleTransitionError("이미 소진한 병의 소진일은 다시 기록할 수 없습니다")

    before = _state(bottle)
    when = finished_on or local_today()
    # 지역 변수로 받아 둔다. 속성에 대입한 뒤에는 타입이 좁혀지지 않는다.
    opened_on = bottle.opened_on if bottle.opened_on is not None else when
    if when < opened_on:
        raise BottleInputError("소진일이 개봉일보다 앞설 수 없습니다")
    bottle.opened_on = opened_on

    bottle.status = BottleStatus.FINISHED
    bottle.finished_on = when
    bottle.remaining_ml = 0
    _log_transition(session, bottle, "finish", before)
    await session.flush()
    return bottle


async def hand_over_bottle(
    session: AsyncSession,
    bottle: Bottle,
    *,
    status: BottleStatus,
    note: str | None = None,
    on: datetime.date | None = None,
) -> Bottle:
    """병을 증여하거나 판매한다.

    소진과 달리 잔량을 0 으로 만들지 않는다. 남은 양이 있는 채로 넘긴 사실을 보존해야 한다.
    재고 집계에서는 `IN_STOCK_STATUSES` 가 이미 제외한다.
    """
    if status not in {BottleStatus.GIFTED, BottleStatus.SOLD}:
        raise BottleTransitionError("증여 또는 판매 상태만 지정할 수 있습니다")
    if bottle.status == BottleStatus.FINISHED:
        raise BottleTransitionError("이미 소진한 병은 넘길 수 없습니다")
    if bottle.status in {BottleStatus.GIFTED, BottleStatus.SOLD}:
        raise BottleTransitionError("이미 내보낸 병의 처분 상태는 다시 기록할 수 없습니다")

    when = on or local_today()
    if bottle.opened_on is not None and when < bottle.opened_on:
        raise BottleInputError("증여·판매일이 개봉일보다 앞설 수 없습니다")

    before = _state(bottle)
    bottle.status = status
    bottle.finished_on = when
    if note:
        bottle.note = f"{bottle.note}\n{note}" if bottle.note else note
    action = "gift" if status == BottleStatus.GIFTED else "sell"
    _log_transition(session, bottle, action, before, **({"note": note} if note else {}))
    await session.flush()
    return bottle


async def reopen_bottle(session: AsyncSession, bottle: Bottle) -> Bottle:
    """상태를 개봉으로 되돌린다.

    잘못 누른 경우를 위한 되돌리기다. 기록을 지우는 것이 아니라 상태만 바꾼다. 소진일을 지운다.
    소진 처리로 0 이 된 잔량은 실제 남은 양이 아니므로 "미기록"(`None`)으로 돌린다 — 0 으로
    두면 되돌린 병에 시음을 기록할 때 잔량 부족으로 막힌다. 사용자가 `set_remaining` 으로
    실제 잔량을 다시 입력할 수 있다.
    """
    if bottle.status == BottleStatus.UNOPENED:
        raise BottleTransitionError("미개봉 병은 되돌릴 상태가 없습니다")

    before = _state(bottle)
    bottle.status = BottleStatus.OPEN
    bottle.finished_on = None
    if bottle.remaining_ml == 0:
        bottle.remaining_ml = None
    if bottle.opened_on is None:
        bottle.opened_on = local_today()
    _log_transition(session, bottle, "reopen", before)
    await session.flush()
    return bottle


async def set_remaining(
    session: AsyncSession, bottle: Bottle, *, remaining_ml: int, on: datetime.date | None = None
) -> Bottle:
    """개봉 병의 잔량을 직접 맞춘다(눈대중 25/50/75% 등).

    시음 기록 없이 줄어든 양(요리·나눔)이나 잘못 기록된 잔량을 바로잡는 용도다. 0 이면
    소진으로 처리한다 — 시음 기록이 잔량 0 에서 자동 소진하는 규칙과 같다.
    """
    if bottle.status != BottleStatus.OPEN:
        raise BottleTransitionError(
            f"개봉한 병만 잔량을 조정할 수 있습니다 (현재 상태: {bottle.status})"
        )
    if remaining_ml < 0:
        raise BottleInputError("잔량은 0 이상이어야 합니다")
    volume = await _bottle_volume_ml(session, bottle)
    if volume is not None and remaining_ml > volume:
        raise BottleInputError(f"잔량이 병 용량({volume}ml)보다 클 수 없습니다")
    if remaining_ml == 0:
        return await finish_bottle(session, bottle, finished_on=on)
    before = _state(bottle)
    bottle.remaining_ml = remaining_ml
    _log_transition(session, bottle, "set_remaining", before)
    await session.flush()
    return bottle


async def unopen_bottle(session: AsyncSession, bottle: Bottle) -> Bottle:
    """개봉을 실수로 눌렀을 때를 위한 되돌리기. 개봉 상태만 미개봉으로 되돌릴 수 있다.

    소진·증여·판매까지 간 병은 `reopen_bottle` 로 다시 개봉한 뒤에나 미개봉으로 되돌릴 수
    있다 — 이미 넘기거나 마신 기록을 조용히 지우면 안 되기 때문이다.
    """
    if bottle.status != BottleStatus.OPEN:
        raise BottleTransitionError(
            f"개봉 상태만 미개봉으로 되돌릴 수 있습니다 (현재 상태: {bottle.status})"
        )

    before = _state(bottle)
    bottle.status = BottleStatus.UNOPENED
    bottle.opened_on = None
    bottle.remaining_ml = None
    _log_transition(session, bottle, "unopen", before)
    await session.flush()
    return bottle


@dataclass(frozen=True)
class TastingInput:
    """시음 기록 입력."""

    tasted_on: datetime.date
    poured_ml: int | None = None
    rating: Decimal | None = None
    nose: str | None = None
    palate: str | None = None
    finish: str | None = None
    note: str | None = None
    place: str | None = None
    companions: str | None = None


async def record_tasting(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    sku_id: uuid.UUID,
    data: TastingInput,
    bottle: Bottle | None = None,
    finish_if_empty: bool = True,
    id: uuid.UUID | None = None,  # noqa: A002 - 오프라인 outbox 가 미리 생성한 PK
    reconcile: bool = False,
) -> TastingSession:
    """시음을 기록하고 병 잔량을 차감한다.

    병에서 마신 경우 잔량이 부족하면 거부한다. 잔량보다 많이 따를 수는 없고, 그런 입력은
    대개 단위 착각(50ml 을 500 으로)이다. 조용히 음수로 만들면 통계가 틀린다.

    잔량이 0 이 되면 자동으로 소진 처리한다. 마지막 잔을 마신 뒤 따로 소진 버튼을 누르게 하면
    잊어버려 재고가 남아 있는 것처럼 보인다.

    `id` 를 지정하면 그대로 쓴다 — 오프라인 클라이언트가 미리 생성한 UUIDv7 PK 를 반영한다.

    `reconcile=True` 는 오프라인에서 이미 일어난 시음을 나중에 반영할 때 쓴다. 다른 기기가
    그 사이 잔량을 줄였거나 병을 내보냈어도 마신 사실은 잃지 않는다 — 잔량은 0 으로 맞추고,
    이미 내보내거나 소진한 병은 상태·날짜를 바꾸지 않은 채 기록만 연결한다.
    """
    validate_rating(data.rating)

    bottle_before = _state(bottle) if bottle is not None else None
    if bottle is not None:
        # 늦게 도착한 오프라인 시음은 이미 소진된 병의 개봉·소진일과 잔량을 다시 쓰지 않는다.
        # 마신 사실만 연결한다(내보낸 병과 같은 규칙).
        handed_over = bottle.status in {BottleStatus.GIFTED, BottleStatus.SOLD} or (
            reconcile and bottle.status == BottleStatus.FINISHED
        )
        if bottle.status == BottleStatus.UNOPENED:
            # 시음 이력 한 줄에 개봉까지 함께 남긴다(개봉 이력을 따로 쌓지 않는다).
            await open_bottle(session, bottle, opened_on=data.tasted_on, log=False)
        elif handed_over and not reconcile:
            raise BottleTransitionError(
                f"내보낸 병은 시음을 기록할 수 없습니다 (현재 상태: {bottle.status})"
            )

        if not handed_over and (bottle.opened_on is None or data.tasted_on < bottle.opened_on):
            # 기록된 개봉일보다 앞선 날 마셨다면 실제로는 그날 이미 열려 있었다. 그대로 두면
            # 마지막 잔으로 소진할 때 소진일이 개봉일보다 앞서 저장이 거부된다.
            bottle.opened_on = data.tasted_on

        if data.poured_ml is not None and not handed_over:
            remaining = bottle.remaining_ml
            if remaining is None:
                remaining = await _bottle_volume_ml(session, bottle) or 0
            if data.poured_ml > remaining:
                if not reconcile:
                    raise InsufficientRemainingError(remaining, data.poured_ml)
                remaining = data.poured_ml
            bottle.remaining_ml = remaining - data.poured_ml

            if bottle.remaining_ml == 0 and finish_if_empty:
                bottle.status = BottleStatus.FINISHED
                bottle.finished_on = data.tasted_on

    kwargs: dict[str, Any] = {
        "user_id": user_id,
        "sku_id": sku_id,
        "bottle_id": bottle.id if bottle is not None else None,
        "tasted_on": data.tasted_on,
        "poured_ml": data.poured_ml,
        "rating": data.rating,
        "nose": data.nose,
        "palate": data.palate,
        "finish": data.finish,
        "note": data.note,
        "place": data.place,
        "companions": data.companions,
    }
    if id is not None:
        kwargs["id"] = id
    record = TastingSession(**kwargs)
    session.add(record)
    if bottle is not None and bottle_before is not None:
        _log_transition(
            session,
            bottle,
            "tasting",
            bottle_before,
            tasted_on=data.tasted_on,
            **({"poured_ml": data.poured_ml} if data.poured_ml is not None else {}),
        )
    await session.flush()
    return record


@dataclass(frozen=True)
class TastingSummary:
    """시음 요약.

    평점이 없는 세션은 평균에서 제외한다. 0 으로 세면 평점을 적지 않은 기록이 평균을 끌어내린다.
    """

    session_count: int
    rated_count: int
    average_rating: Decimal | None
    first_rating: Decimal | None
    latest_rating: Decimal | None
    total_poured_ml: int
    first_tasted_on: datetime.date | None
    latest_tasted_on: datetime.date | None

    @property
    def rating_change(self) -> Decimal | None:
        """첫 평점 대비 최근 평점의 변화. 처음과 지금의 인상이 얼마나 달라졌는지."""
        if self.first_rating is None or self.latest_rating is None:
            return None
        return self.latest_rating - self.first_rating


async def summarize_tastings(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    sku_id: uuid.UUID | None = None,
    bottle_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    tasted_on_min: datetime.date | None = None,
    tasted_on_max: datetime.date | None = None,
) -> TastingSummary:
    """시음 요약을 계산한다. 저장하지 않고 매번 센다(파생값 비저장 규칙)."""
    filters = tasting_conditions(
        user_id,
        product_id=product_id,
        sku_id=sku_id,
        bottle_id=bottle_id,
        tasted_on_min=tasted_on_min,
        tasted_on_max=tasted_on_max,
    )

    aggregate = (
        await session.execute(
            select(
                func.count(TastingSession.id),
                func.count(TastingSession.rating),
                func.avg(TastingSession.rating),
                func.coalesce(func.sum(TastingSession.poured_ml), 0),
                func.min(TastingSession.tasted_on),
                func.max(TastingSession.tasted_on),
            ).where(*filters)
        )
    ).one()

    session_count, rated_count, average, total_poured, first_on, latest_on = aggregate

    # 첫·최근 평점은 평점이 있는 세션만 본다. 같은 날 여러 번이면 id 로 순서를 고정한다.
    rated_filters = [*filters, TastingSession.rating.is_not(None)]
    first_rating = await session.scalar(
        select(TastingSession.rating)
        .where(*rated_filters)
        .order_by(TastingSession.tasted_on.asc(), TastingSession.id.asc())
        .limit(1)
    )
    latest_rating = await session.scalar(
        select(TastingSession.rating)
        .where(*rated_filters)
        .order_by(TastingSession.tasted_on.desc(), TastingSession.id.desc())
        .limit(1)
    )

    return TastingSummary(
        session_count=int(session_count or 0),
        rated_count=int(rated_count or 0),
        average_rating=(
            Decimal(str(average)).quantize(Decimal("0.01")) if average is not None else None
        ),
        first_rating=first_rating,
        latest_rating=latest_rating,
        total_poured_ml=int(total_poured or 0),
        first_tasted_on=first_on,
        latest_tasted_on=latest_on,
    )


async def list_tastings(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    sku_id: uuid.UUID | None = None,
    bottle_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    tasted_on_min: datetime.date | None = None,
    tasted_on_max: datetime.date | None = None,
    limit: int = 50,
    before: tuple[datetime.date, uuid.UUID] | None = None,
) -> list[TastingSession]:
    """시음 타임라인. 최근 순으로 반환한다."""
    filters = tasting_conditions(
        user_id,
        product_id=product_id,
        sku_id=sku_id,
        bottle_id=bottle_id,
        tasted_on_min=tasted_on_min,
        tasted_on_max=tasted_on_max,
    )
    if before is not None:
        tasted_on, tasting_id = before
        filters.append(
            or_(
                TastingSession.tasted_on < tasted_on,
                and_(TastingSession.tasted_on == tasted_on, TastingSession.id < tasting_id),
            )
        )

    result = await session.scalars(
        select(TastingSession)
        .where(*filters)
        .order_by(TastingSession.tasted_on.desc(), TastingSession.id.desc())
        .limit(limit)
    )
    return list(result)


def _live_tasting_conditions(user_id: uuid.UUID) -> list[Any]:
    live_skus = (
        select(Sku.id)
        .join(Product, Product.id == Sku.product_id)
        .where(
            Sku.user_id == user_id,
            Sku.deleted_at.is_(None),
            Product.user_id == user_id,
            Product.deleted_at.is_(None),
        )
    )
    return [
        TastingSession.user_id == user_id,
        TastingSession.deleted_at.is_(None),
        TastingSession.sku_id.in_(live_skus),
        or_(
            TastingSession.bottle_id.is_(None),
            TastingSession.bottle_id.in_(live_bottles_query(user_id).with_only_columns(Bottle.id)),
        ),
    ]


def tasting_conditions(
    user_id: uuid.UUID,
    *,
    product_id: uuid.UUID | None = None,
    sku_id: uuid.UUID | None = None,
    bottle_id: uuid.UUID | None = None,
    tasted_on_min: datetime.date | None = None,
    tasted_on_max: datetime.date | None = None,
) -> list[Any]:
    from sooljang.api.errors import ValidationFailedError

    if tasted_on_min and tasted_on_max and tasted_on_min > tasted_on_max:
        raise ValidationFailedError("시음 시작일은 종료일보다 늦을 수 없습니다")
    filters = _live_tasting_conditions(user_id)
    if sku_id is not None:
        filters.append(TastingSession.sku_id == sku_id)
    if bottle_id is not None:
        filters.append(TastingSession.bottle_id == bottle_id)
    if product_id is not None:
        filters.append(
            TastingSession.sku_id.in_(
                select(Sku.id).where(Sku.product_id == product_id, Sku.user_id == user_id)
            )
        )
    if tasted_on_min is not None:
        filters.append(TastingSession.tasted_on >= tasted_on_min)
    if tasted_on_max is not None:
        filters.append(TastingSession.tasted_on <= tasted_on_max)
    return filters
