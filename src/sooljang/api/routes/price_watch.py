"""가격 감시·수동 이력·앱 내 알림과 별도 명시 푸시 구독."""

import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query, Request, status
from sqlalchemy import select

from sooljang.api.deps import SessionDep, SettingsDep, UserDep
from sooljang.api.errors import ConflictError, NotFoundError
from sooljang.api.schemas.price_watch import (
    SubscriptionCreate,
    WatchCheck,
    WatchCreate,
    WatchRevision,
    WatchUpdate,
)
from sooljang.application import price_watch as service
from sooljang.application.price_watch_worker import enqueue_manual
from sooljang.infrastructure.database.models import ExternalPriceObservation
from sooljang.infrastructure.database.models.price_watch import (
    PriceNotification,
    PriceWatch,
    PriceWatchRun,
    PushDelivery,
    PushSubscription,
)

router = APIRouter(prefix="/price-watch", tags=["price-watch"])


@router.get("/config")
async def configuration(settings: SettingsDep, request: Request) -> dict[str, Any]:
    return {
        **service.push_configuration(settings),
        "worker": getattr(request.app.state, "price_watch_worker", {"state": "disabled"}),
    }


@router.get("")
async def watches(
    session: SessionDep, user_id: UserDep, interest_id: uuid.UUID | None = None
) -> list[dict[str, Any]]:
    statement = select(PriceWatch).where(
        PriceWatch.user_id == user_id, PriceWatch.deleted_at.is_(None)
    )
    if interest_id is not None:
        await service.owned_interest(session, user_id=user_id, interest_id=interest_id)
        statement = statement.where(PriceWatch.interest_id == interest_id)
    rows = await session.scalars(
        statement.order_by(PriceWatch.created_at, PriceWatch.id).limit(100)
    )
    return [await service.watch_view(session, row) for row in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create(payload: WatchCreate, session: SessionDep, user_id: UserDep) -> dict[str, Any]:
    watch = await service.create_watch(session, user_id=user_id, **payload.model_dump())
    return await service.watch_view(session, watch)


@router.get("/interests/{interest_id}/history")
async def history(
    interest_id: uuid.UUID,
    session: SessionDep,
    user_id: UserDep,
    before: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=200),
) -> list[dict[str, Any]]:
    return await service.price_history(
        session, user_id=user_id, interest_id=interest_id, before=before, limit=limit
    )


@router.get("/products/{product_id}/history")
async def product_history(
    product_id: uuid.UUID,
    session: SessionDep,
    user_id: UserDep,
    before: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=200),
) -> list[dict[str, Any]]:
    return await service.price_history(
        session, user_id=user_id, product_id=product_id, before=before, limit=limit
    )


@router.get("/runs/{run_id}")
async def read_run(run_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> dict[str, Any]:
    row = await session.scalar(
        select(PriceWatchRun).where(PriceWatchRun.id == run_id, PriceWatchRun.user_id == user_id)
    )
    if row is None:
        raise NotFoundError("가격 조회 작업을 찾을 수 없습니다")
    return service.run_view(row)


@router.get("/notifications")
async def notifications(session: SessionDep, user_id: UserDep) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(PriceNotification)
        .where(PriceNotification.user_id == user_id)
        .order_by(PriceNotification.created_at.desc(), PriceNotification.id.desc())
        .limit(100)
    )
    result = []
    for row in rows:
        observation = (
            await session.scalar(
                select(ExternalPriceObservation).where(
                    ExternalPriceObservation.id == row.observation_id,
                    ExternalPriceObservation.user_id == user_id,
                )
            )
            if row.observation_id is not None
            else None
        )
        deliveries = list(
            await session.scalars(
                select(PushDelivery.status).where(
                    PushDelivery.notification_id == row.id, PushDelivery.user_id == user_id
                )
            )
        )
        result.append(
            {
                "id": row.id,
                "watch_id": row.watch_id,
                "interest_id": row.interest_id,
                "created_at": row.created_at,
                "read_at": row.read_at,
                "delivery_states": deliveries,
                "amount": str(observation.amount) if observation is not None else None,
                "currency": observation.currency if observation is not None else None,
                "source_url": observation.source_url if observation is not None else None,
                "observed_at": observation.fetched_at if observation is not None else None,
            }
        )
    return result


@router.post("/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(notification_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    row = await session.scalar(
        select(PriceNotification)
        .where(PriceNotification.id == notification_id, PriceNotification.user_id == user_id)
        .with_for_update()
    )
    if row is None:
        raise NotFoundError("알림을 찾을 수 없습니다")
    if row.read_at is None:
        row.read_at = datetime.now(UTC)


@router.get("/subscriptions")
async def subscriptions(
    session: SessionDep, user_id: UserDep, settings: SettingsDep
) -> list[dict[str, Any]]:
    rows = await session.scalars(
        select(PushSubscription)
        .where(PushSubscription.user_id == user_id, PushSubscription.deleted_at.is_(None))
        .order_by(PushSubscription.created_at)
    )
    public_key = service.push_configuration(settings)["public_key"]
    active_key_id = hashlib.sha256(public_key.encode()).hexdigest() if public_key else None
    return [service.subscription_view(row, active_key_id) for row in rows]


@router.post("/subscriptions", status_code=status.HTTP_201_CREATED)
async def subscribe(
    payload: SubscriptionCreate, session: SessionDep, user_id: UserDep, settings: SettingsDep
) -> dict[str, Any]:
    row = await service.register_subscription(
        session,
        user_id=user_id,
        endpoint=payload.endpoint.get_secret_value(),
        p256dh=payload.keys.p256dh.get_secret_value(),
        auth=payload.keys.auth.get_secret_value(),
        expires_at=payload.expires_at,
        settings=settings,
    )
    return service.subscription_view(row)


@router.delete("/subscriptions/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(subscription_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    await service.unsubscribe(session, user_id=user_id, subscription_id=subscription_id)


@router.patch("/{watch_id}")
async def edit(
    watch_id: uuid.UUID, payload: WatchUpdate, session: SessionDep, user_id: UserDep
) -> dict[str, Any]:
    watch = await service.update_watch(
        session,
        user_id=user_id,
        watch_id=watch_id,
        expected_revision=payload.expected_revision,
        fields=payload.model_dump(exclude_unset=True, exclude={"expected_revision"}),
    )
    return await service.watch_view(session, watch)


@router.delete("/{watch_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove(
    watch_id: uuid.UUID, payload: WatchRevision, session: SessionDep, user_id: UserDep
) -> None:
    await service.remove_watch(
        session, user_id=user_id, watch_id=watch_id, expected_revision=payload.expected_revision
    )


@router.post("/{watch_id}/check", status_code=status.HTTP_202_ACCEPTED)
async def check(
    watch_id: uuid.UUID,
    payload: WatchCheck,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    if not settings.price_watch_worker_enabled:
        raise ConflictError("서버의 가격 감시 작업 실행이 꺼져 있습니다")
    row = await enqueue_manual(
        session,
        user_id=user_id,
        watch_id=watch_id,
        expected_revision=payload.expected_revision,
        request_id=payload.request_id,
    )
    return service.run_view(row)
