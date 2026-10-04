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

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.clock import local_today
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Purchase,
    Sku,
    TastingSession,
)

#: 재고로 세는 상태. 증여·판매·소진은 재고가 아니다.
OPEN_STATUSES = frozenset({BottleStatus.OPEN})


class BottleTransitionError(Exception):
    """허용되지 않는 상태 전이."""


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


async def load_bottle_for_write(
    session: AsyncSession, *, user_id: uuid.UUID, bottle_id: uuid.UUID
) -> Bottle | None:
    """온라인·outbox가 상태/잔량을 읽기 전에 같은 행 잠금을 얻는다."""
    return await session.scalar(
        select(Bottle)
        .where(Bottle.id == bottle_id, Bottle.user_id == user_id, Bottle.deleted_at.is_(None))
        .with_for_update()
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
) -> Bottle:
    """병을 개봉한다.

    잔량을 지정하지 않으면 규격 용량 전량으로 초기화한다. 개봉 직후 잔량은 용량과 같다.
    """
    if bottle.status != BottleStatus.UNOPENED:
        raise BottleTransitionError(f"미개봉 병만 개봉할 수 있습니다 (현재 상태: {bottle.status})")

    bottle.status = BottleStatus.OPEN
    bottle.opened_on = opened_on or local_today()
    if remaining_ml is not None:
        bottle.remaining_ml = remaining_ml
    else:
        bottle.remaining_ml = await _bottle_volume_ml(session, bottle)
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

    when = finished_on or local_today()
    # 지역 변수로 받아 둔다. 속성에 대입한 뒤에는 타입이 좁혀지지 않는다.
    opened_on = bottle.opened_on if bottle.opened_on is not None else when
    if when < opened_on:
        raise BottleTransitionError("소진일이 개봉일보다 앞설 수 없습니다")
    bottle.opened_on = opened_on

    bottle.status = BottleStatus.FINISHED
    bottle.finished_on = when
    bottle.remaining_ml = 0
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

    when = on or local_today()
    if bottle.opened_on is not None and when < bottle.opened_on:
        raise BottleTransitionError("증여·판매일이 개봉일보다 앞설 수 없습니다")

    bottle.status = status
    bottle.finished_on = when
    if note:
        bottle.note = f"{bottle.note}\n{note}" if bottle.note else note
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

    bottle.status = BottleStatus.OPEN
    bottle.finished_on = None
    if bottle.remaining_ml == 0:
        bottle.remaining_ml = None
    if bottle.opened_on is None:
        bottle.opened_on = local_today()
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
        raise BottleTransitionError("잔량은 0 이상이어야 합니다")
    volume = await _bottle_volume_ml(session, bottle)
    if volume is not None and remaining_ml > volume:
        raise BottleTransitionError(f"잔량이 병 용량({volume}ml)보다 클 수 없습니다")
    if remaining_ml == 0:
        return await finish_bottle(session, bottle, finished_on=on)
    bottle.remaining_ml = remaining_ml
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

    bottle.status = BottleStatus.UNOPENED
    bottle.opened_on = None
    bottle.remaining_ml = None
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
    이미 내보낸 병은 상태를 바꾸지 않은 채 기록만 연결한다.
    """
    validate_rating(data.rating)

    if bottle is not None:
        handed_over = bottle.status in {BottleStatus.GIFTED, BottleStatus.SOLD}
        if bottle.status == BottleStatus.UNOPENED:
            await open_bottle(session, bottle, opened_on=data.tasted_on)
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
) -> TastingSummary:
    """시음 요약을 계산한다. 저장하지 않고 매번 센다(파생값 비저장 규칙)."""
    filters = [TastingSession.user_id == user_id, TastingSession.deleted_at.is_(None)]
    if sku_id is not None:
        filters.append(TastingSession.sku_id == sku_id)
    if bottle_id is not None:
        filters.append(TastingSession.bottle_id == bottle_id)

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
    limit: int = 50,
) -> list[TastingSession]:
    """시음 타임라인. 최근 순으로 반환한다."""
    filters = [TastingSession.user_id == user_id, TastingSession.deleted_at.is_(None)]
    if sku_id is not None:
        filters.append(TastingSession.sku_id == sku_id)
    if bottle_id is not None:
        filters.append(TastingSession.bottle_id == bottle_id)

    result = await session.scalars(
        select(TastingSession)
        .where(*filters)
        .order_by(TastingSession.tasted_on.desc(), TastingSession.id.desc())
        .limit(limit)
    )
    return list(result)
