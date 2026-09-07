"""DB occurrence/lease로 가격 조회와 푸시 전달을 분리하고 재시작 폭주를 막는다."""

import asyncio
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import and_, exists, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError
from sooljang.application.price_watch import (
    blocking_reason,
    owned_watch,
    push_configuration,
    watch_criteria,
)
from sooljang.application.provider_connections import ConnectionChanged
from sooljang.config import Settings
from sooljang.domain.discovery import SourceOutcome
from sooljang.domain.price_watch import (
    WatchObservation,
    evaluate_price,
    scheduled_slot,
    should_notify,
)
from sooljang.infrastructure.database.models import ExternalOffer, ExternalPriceObservation
from sooljang.infrastructure.database.models.price_watch import (
    PriceNotification,
    PriceWatch,
    PriceWatchRun,
    PushDelivery,
    PushSubscription,
)
from sooljang.infrastructure.database.session import get_session_factory
from sooljang.infrastructure.external.request_guard import outbound_guard
from sooljang.infrastructure.security.secrets import decrypt_secret
from sooljang.infrastructure.web_push import PushOutcome, build_push_request, send_push

logger = logging.getLogger(__name__)
MAX_BATCH = 10
RUN_LEASE_SECONDS = 120
DELIVERY_LEASE_SECONDS = 30
MAX_ATTEMPTS = 3
MAX_PENDING_DELIVERIES = 500
_SCHEDULER_LOCK = 757170128


@dataclass(frozen=True, slots=True)
class RunLease:
    run_id: uuid.UUID
    watch_id: uuid.UUID
    user_id: uuid.UUID
    token: uuid.UUID
    revision: int


async def enqueue_manual(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    watch_id: uuid.UUID,
    expected_revision: int,
    request_id: uuid.UUID,
    now: datetime | None = None,
) -> PriceWatchRun:
    now = now or datetime.now(UTC)
    watch = await owned_watch(session, user_id=user_id, watch_id=watch_id, lock=True)
    if watch.config_revision != expected_revision:
        raise ConflictError("감시 설정이 바뀌었습니다. 최신 상태에서 다시 조회하세요")
    reason = await blocking_reason(session, watch)
    if reason is not None:
        raise ConflictError("감시 대상·소스·연결의 사용 상태와 가격 이력 보관 허용을 확인하세요")
    occurrence = f"manual:{request_id}"
    existing = await session.scalar(
        select(PriceWatchRun)
        .where(
            PriceWatchRun.watch_id == watch.id,
            or_(
                PriceWatchRun.occurrence_key == occurrence,
                PriceWatchRun.status.in_(["queued", "running"]),
            ),
        )
        .order_by(PriceWatchRun.created_at)
        .limit(1)
    )
    if existing is not None:
        return existing
    run = PriceWatchRun(
        user_id=user_id,
        watch_id=watch.id,
        occurrence_key=occurrence,
        scheduled_for=now,
        watch_revision=watch.config_revision,
        available_at=now,
    )
    session.add(run)
    await session.flush()
    return run


async def enqueue_due(session: AsyncSession, *, now: datetime) -> int:
    """DB transaction lock과 대상별 미처리 작업 1건으로 중복 enqueue를 막는다."""
    if not await session.scalar(
        text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": _SCHEDULER_LOCK}
    ):
        return 0
    watches = await session.scalars(
        select(PriceWatch)
        .where(
            PriceWatch.deleted_at.is_(None),
            PriceWatch.is_active.is_(True),
            PriceWatch.schedule_enabled.is_(True),
            PriceWatch.next_due_at <= now,
        )
        .order_by(PriceWatch.next_due_at, PriceWatch.id)
        .limit(MAX_BATCH)
        .with_for_update(skip_locked=True)
    )
    count = 0
    for watch in watches:
        slot = scheduled_slot(now, watch.interval_seconds)
        watch.next_due_at = slot + timedelta(seconds=watch.interval_seconds)
        reason = await blocking_reason(session, watch)
        if reason is not None:
            watch.last_outcome = reason
            continue
        if await session.scalar(
            select(
                exists().where(
                    PriceWatchRun.watch_id == watch.id,
                    PriceWatchRun.status.in_(["queued", "running"]),
                )
            )
        ):
            continue
        identity = uuid.uuid5(watch.id, f"schedule:{watch.config_revision}:{slot.isoformat()}")
        result = await session.execute(
            insert(PriceWatchRun)
            .values(
                id=identity,
                user_id=watch.user_id,
                watch_id=watch.id,
                occurrence_key=f"schedule:{watch.config_revision}:{slot.isoformat()}",
                scheduled_for=slot,
                watch_revision=watch.config_revision,
                status="queued",
                attempts=0,
                available_at=now,
            )
            .on_conflict_do_nothing(index_elements=["watch_id", "occurrence_key"])
            .returning(PriceWatchRun.id)
        )
        count += result.first() is not None
    return count


async def claim_run(session: AsyncSession, *, now: datetime) -> RunLease | None:
    # 오래 멈춘 마지막 시도는 재실행하지 않는다. 다른 프로세스의 늦은 응답은 token으로 막는다.
    await session.execute(
        update(PriceWatchRun)
        .where(
            PriceWatchRun.status == "running",
            PriceWatchRun.lease_until <= now,
            PriceWatchRun.attempts >= MAX_ATTEMPTS,
        )
        .values(status="failed", outcome="interrupted", finished_at=now)
    )
    run = await session.scalar(
        select(PriceWatchRun)
        .where(
            PriceWatchRun.attempts < MAX_ATTEMPTS,
            or_(
                and_(PriceWatchRun.status == "queued", PriceWatchRun.available_at <= now),
                and_(PriceWatchRun.status == "running", PriceWatchRun.lease_until <= now),
            ),
        )
        .order_by(PriceWatchRun.available_at, PriceWatchRun.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if run is None:
        return None
    watch = await session.scalar(
        select(PriceWatch).where(PriceWatch.id == run.watch_id, PriceWatch.user_id == run.user_id)
    )
    if (
        watch is None
        or watch.config_revision != run.watch_revision
        or (reason := await blocking_reason(session, watch)) is not None
    ):
        run.status = "cancelled"
        run.outcome = (
            "configuration_changed"
            if watch is None or watch.config_revision != run.watch_revision
            else reason or "configuration_changed"
        )
        run.finished_at = now
        return None
    run.status = "running"
    run.attempts += 1
    token = uuid.uuid4()
    run.lease_token = token
    run.lease_until = now + timedelta(seconds=RUN_LEASE_SECONDS)
    return RunLease(run.id, watch.id, watch.user_id, token, watch.config_revision)


async def _run_guard(lease: RunLease, _request: httpx.Request) -> None:
    async with get_session_factory()() as session:
        run = await session.scalar(
            select(PriceWatchRun).where(
                PriceWatchRun.id == lease.run_id,
                PriceWatchRun.user_id == lease.user_id,
                PriceWatchRun.status == "running",
                PriceWatchRun.lease_token == lease.token,
                PriceWatchRun.lease_until > datetime.now(UTC),
            )
        )
        watch = await session.scalar(
            select(PriceWatch).where(
                PriceWatch.id == lease.watch_id, PriceWatch.user_id == lease.user_id
            )
        )
        if (
            run is None
            or watch is None
            or watch.config_revision != lease.revision
            or await blocking_reason(session, watch) is not None
        ):
            raise ConnectionChanged("감시가 중지되었거나 작업 소유권이 바뀌었습니다")


async def _finish_failed(
    lease: RunLease, *, outcome: str, now: datetime, retry: bool = False
) -> None:
    async with get_session_factory().begin() as session:
        watch = await session.scalar(
            select(PriceWatch)
            .where(PriceWatch.id == lease.watch_id, PriceWatch.user_id == lease.user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        run = await session.scalar(
            select(PriceWatchRun)
            .where(
                PriceWatchRun.id == lease.run_id,
                PriceWatchRun.status == "running",
                PriceWatchRun.lease_token == lease.token,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if run is None:
            return

        if (
            watch is None
            or watch.config_revision != lease.revision
            or await blocking_reason(session, watch) is not None
        ):
            run.status = "cancelled"
            run.outcome = "configuration_changed"
            run.finished_at = now
            return
        watch.last_checked_at = now
        watch.last_outcome = outcome
        run.outcome = outcome
        run.lease_until = None
        if retry and run.attempts < MAX_ATTEMPTS:
            run.status = "queued"
            run.available_at = now + timedelta(seconds=60 * 2 ** (run.attempts - 1))
        else:
            run.status = "failed"
            run.finished_at = now


async def _record_notification(
    session: AsyncSession,
    *,
    watch: PriceWatch,
    observation_id: uuid.UUID,
    now: datetime,
    settings: Settings,
) -> bool:
    notification_id = uuid.uuid5(watch.id, f"observation:{observation_id}")
    result = await session.execute(
        insert(PriceNotification)
        .values(
            id=notification_id,
            user_id=watch.user_id,
            watch_id=watch.id,
            interest_id=watch.interest_id,
            observation_id=observation_id,
            watch_revision=watch.config_revision,
            created_at=now,
        )
        .on_conflict_do_nothing(index_elements=["watch_id", "observation_id"])
        .returning(PriceNotification.id)
    )
    if result.first() is None:
        return False
    if not watch.push_enabled:
        return True
    configuration = push_configuration(settings)
    if not configuration["configured"]:
        return True
    key_id = hashlib.sha256(configuration["public_key"].encode()).hexdigest()
    subscriptions = await session.scalars(
        select(PushSubscription)
        .where(
            PushSubscription.user_id == watch.user_id,
            PushSubscription.deleted_at.is_(None),
            PushSubscription.is_active.is_(True),
            PushSubscription.vapid_key_id == key_id,
            or_(PushSubscription.expires_at.is_(None), PushSubscription.expires_at > now),
        )
        .order_by(PushSubscription.id)
        .limit(5)
    )
    await session.execute(
        text("SELECT pg_advisory_xact_lock(757170131, :owner)"),
        {"owner": watch.user_id.int & 0x7FFFFFFF},
    )
    pending = (
        await session.scalar(
            select(func.count())
            .select_from(PushDelivery)
            .where(
                PushDelivery.user_id == watch.user_id,
                PushDelivery.status.in_(["queued", "sending"]),
            )
        )
        or 0
    )
    for subscription in subscriptions:
        queued = pending < MAX_PENDING_DELIVERIES
        identity = uuid.uuid5(notification_id, str(subscription.id))
        await session.execute(
            insert(PushDelivery)
            .values(
                id=identity,
                user_id=watch.user_id,
                notification_id=notification_id,
                subscription_id=subscription.id,
                status="queued" if queued else "queue_full",
                attempts=0,
                available_at=now,
                created_at=now,
            )
            .on_conflict_do_nothing(index_elements=["notification_id", "subscription_id"])
        )
        pending += int(queued)
    return True


async def process_results(
    session: AsyncSession, *, lease: RunLease, results: list[Any], now: datetime, settings: Settings
) -> None:
    watch = await session.scalar(
        select(PriceWatch)
        .where(PriceWatch.id == lease.watch_id, PriceWatch.user_id == lease.user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    run = await session.scalar(
        select(PriceWatchRun)
        .where(
            PriceWatchRun.id == lease.run_id,
            PriceWatchRun.status == "running",
            PriceWatchRun.lease_token == lease.token,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None:
        return

    if (
        watch is None
        or watch.config_revision != lease.revision
        or await blocking_reason(session, watch) is not None
    ):
        run.status = "cancelled"
        run.outcome = "configuration_changed"
        run.finished_at = now
        return
    source_result = next(
        (result for result in results if result.source_id == watch.source_id), None
    )
    watch.last_checked_at = now
    run.finished_at = now
    run.lease_until = None
    if source_result is None:
        run.status = "skipped"
        run.outcome = watch.last_outcome = "no_result"
        return
    fresh = (
        not source_result.cached
        and not source_result.degraded
        and source_result.outcome == SourceOutcome.SUCCESS
    )
    if not fresh:
        run.status = "skipped"
        run.outcome = watch.last_outcome = (
            "cached" if source_result.cached else source_result.outcome.value
        )
        if source_result.outcome == SourceOutcome.NETWORK_ERROR and run.attempts < MAX_ATTEMPTS:
            run.status = "queued"
            run.available_at = now + timedelta(seconds=60 * 2 ** (run.attempts - 1))
            run.finished_at = None
        return
    offer = next(
        (
            offer
            for offer in source_result.offers
            if offer.get("condition_key") == watch.condition_key
        ),
        None,
    )
    if offer is None or not offer.get("observation_id") or offer.get("last_good"):
        run.status = "skipped"
        run.outcome = watch.last_outcome = "no_fresh_observation"
        return
    try:
        observation_id = uuid.UUID(offer["observation_id"])
    except ValueError, TypeError:
        run.status = "skipped"
        run.outcome = watch.last_outcome = "unconfirmed"
        return
    observation = await session.scalar(
        select(ExternalPriceObservation)
        .join(ExternalOffer, ExternalOffer.id == ExternalPriceObservation.offer_id)
        .where(
            ExternalPriceObservation.id == observation_id,
            ExternalPriceObservation.user_id == watch.user_id,
            ExternalOffer.user_id == watch.user_id,
            ExternalOffer.interest_id == watch.interest_id,
            ExternalOffer.source_id == watch.source_id,
            ExternalOffer.condition_key == watch.condition_key,
        )
    )
    if observation is None or observation.fetched_at != source_result.fetched_at:
        run.status = "skipped"
        run.outcome = watch.last_outcome = "no_fresh_observation"
        return
    criteria = watch_criteria(watch)
    decision = evaluate_price(
        criteria,
        WatchObservation(
            amount=observation.amount,
            currency=observation.currency,
            fetched_at=observation.fetched_at,
            facts=observation.facts,
            fresh=True,
            complete=True,
            confirmed=source_result.pinned and not offer.get("needs_confirmation", True),
        ),
        now,
    )
    run.status = "succeeded" if decision.eligible else "skipped"
    run.outcome = watch.last_outcome = decision.reason
    if not decision.eligible:
        return
    notify = should_notify(
        decision=decision,
        amount=observation.amount,
        last_amount=watch.last_notified_amount,
        last_satisfied=watch.last_satisfied,
        last_notified_at=watch.last_notified_at,
        now=now,
        cooldown_seconds=watch.cooldown_seconds,
    )
    if notify and await _record_notification(
        session, watch=watch, observation_id=observation_id, now=now, settings=settings
    ):
        watch.last_notified_at = now
        watch.last_notified_amount = observation.amount
        watch.last_satisfied = True
        run.outcome = watch.last_outcome = "notified"
    elif not decision.satisfies:
        # 재진입이 cooldown 안에 일어나도, 다음 유효 관측에서 알릴 기회를 유지한다.
        watch.last_satisfied = False


async def execute_run(
    lease: RunLease, *, settings: Settings, transport: httpx.AsyncBaseTransport | None = None
) -> None:
    from sooljang.application.discovery import lookup_interest

    async def guard(request: httpx.Request) -> None:
        await _run_guard(lease, request)

    try:
        async with get_session_factory().begin() as session:
            watch = await session.get(PriceWatch, lease.watch_id)
            if watch is None:
                return
            with outbound_guard(guard):
                results = await lookup_interest(
                    session,
                    user_id=lease.user_id,
                    interest_id=watch.interest_id,
                    master_key=settings.secret_key,
                    source_ids=[watch.source_id],
                    transport=transport,
                )
            await process_results(
                session, lease=lease, results=results, now=datetime.now(UTC), settings=settings
            )
    except asyncio.CancelledError:
        # 작업을 queued로 되돌리지 않는다. 재시작은 lease 만료/attempt 상한을 거친다.
        raise
    except Exception:
        await _finish_failed(lease, outcome="network_error", now=datetime.now(UTC), retry=True)


@dataclass(frozen=True, slots=True)
class DeliveryLease:
    delivery_id: uuid.UUID
    token: uuid.UUID
    user_id: uuid.UUID


async def claim_delivery(session: AsyncSession, *, now: datetime) -> DeliveryLease | None:
    # sending 이후 프로세스가 죽으면 실제 전달 여부를 알 수 없다. 자동 재전송하지 않는다.
    await session.execute(
        update(PushDelivery)
        .where(PushDelivery.status == "sending", PushDelivery.lease_until <= now)
        .values(status="unknown", finished_at=now)
    )
    delivery = await session.scalar(
        select(PushDelivery)
        .where(
            PushDelivery.status == "queued",
            PushDelivery.available_at <= now,
            PushDelivery.attempts < MAX_ATTEMPTS,
        )
        .order_by(PushDelivery.available_at, PushDelivery.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if delivery is None:
        return None
    delivery.status = "sending"
    delivery.attempts += 1
    token = uuid.uuid4()
    delivery.lease_token = token
    delivery.lease_until = now + timedelta(seconds=DELIVERY_LEASE_SECONDS)
    return DeliveryLease(delivery.id, token, delivery.user_id)


async def _delivery_material(
    session: AsyncSession, *, lease: DeliveryLease, now: datetime, settings: Settings
) -> tuple[PushDelivery, PushSubscription, PriceNotification] | None:
    delivery = await session.scalar(
        select(PushDelivery).where(
            PushDelivery.id == lease.delivery_id,
            PushDelivery.user_id == lease.user_id,
            PushDelivery.status == "sending",
            PushDelivery.lease_token == lease.token,
            PushDelivery.lease_until > now,
        )
    )
    if delivery is None:
        return None
    subscription = await session.scalar(
        select(PushSubscription).where(
            PushSubscription.id == delivery.subscription_id,
            PushSubscription.user_id == lease.user_id,
            PushSubscription.deleted_at.is_(None),
            PushSubscription.is_active.is_(True),
        )
    )
    event = await session.scalar(
        select(PriceNotification).where(
            PriceNotification.id == delivery.notification_id,
            PriceNotification.user_id == lease.user_id,
        )
    )
    if (
        subscription is None
        or subscription.subscription_ciphertext is None
        or event is None
        or event.watch_id is None
        or event.observation_id is None
    ):
        return None
    if subscription.expires_at is not None and subscription.expires_at <= now:
        subscription.is_active = False
        subscription.last_outcome = "expired"
        subscription.subscription_ciphertext = None
        return None
    watch = await session.scalar(
        select(PriceWatch).where(
            PriceWatch.id == event.watch_id, PriceWatch.user_id == lease.user_id
        )
    )
    if (
        watch is None
        or not watch.push_enabled
        or watch.config_revision != event.watch_revision
        or await blocking_reason(session, watch) is not None
    ):
        return None
    configuration = push_configuration(settings)
    if (
        not configuration["configured"]
        or hashlib.sha256(configuration["public_key"].encode()).hexdigest()
        != subscription.vapid_key_id
    ):
        return None
    observation = await session.scalar(
        select(ExternalPriceObservation).where(
            ExternalPriceObservation.id == event.observation_id,
            ExternalPriceObservation.user_id == lease.user_id,
        )
    )
    if observation is None or now - observation.fetched_at > timedelta(
        seconds=watch_criteria(watch).max_age_seconds
    ):
        return None
    return delivery, subscription, event


async def deliver_push(
    lease: DeliveryLease, *, settings: Settings, transport: httpx.AsyncBaseTransport | None = None
) -> None:
    result_outcome = PushOutcome.BLOCKED
    retry_after = None
    try:
        async with get_session_factory().begin() as session:
            material = await _delivery_material(
                session, lease=lease, now=datetime.now(UTC), settings=settings
            )
            if material is None:
                request = None
            else:
                _, subscription, event = material
                assert subscription.subscription_ciphertext is not None
                values = json.loads(
                    decrypt_secret(
                        subscription.subscription_ciphertext, master_key=settings.secret_key
                    )
                )
                request = build_push_request(
                    values,
                    private_key=settings.push_vapid_private_key,
                    subject=settings.push_vapid_subject,
                    event_id=event.id,
                    now=datetime.now(UTC),
                    allowed_hosts=settings.push_allowed_hosts,
                )
        if request is not None:

            async def guard(_request: httpx.Request) -> None:
                async with get_session_factory().begin() as session:
                    if (
                        await _delivery_material(
                            session, lease=lease, now=datetime.now(UTC), settings=settings
                        )
                        is None
                    ):
                        raise ConnectionChanged("푸시 수신 설정이 바뀌었습니다")

            with outbound_guard(guard):
                result = await send_push(request, transport=transport)
            result_outcome = result.outcome
            retry_after = result.retry_after_seconds
    except asyncio.CancelledError:
        raise
    except Exception:
        result_outcome = PushOutcome.BLOCKED
    now = datetime.now(UTC)
    async with get_session_factory().begin() as session:
        row = await session.scalar(
            select(PushDelivery)
            .where(
                PushDelivery.id == lease.delivery_id,
                PushDelivery.status == "sending",
                PushDelivery.lease_token == lease.token,
            )
            .with_for_update()
        )
        if row is None:
            return
        row.status = result_outcome.value
        row.finished_at = now
        row.lease_until = None
        if result_outcome == PushOutcome.RETRYABLE:
            if row.attempts < MAX_ATTEMPTS and retry_after is not None:
                row.status = "queued"
                row.available_at = now + timedelta(seconds=retry_after)
                row.finished_at = None
            else:
                row.status = "rejected"
        subscription = await session.get(PushSubscription, row.subscription_id)
        if subscription is not None and subscription.user_id == lease.user_id:
            subscription.last_outcome = result_outcome.value
            if result_outcome == PushOutcome.EXPIRED:
                subscription.is_active = False
                subscription.subscription_ciphertext = None


async def worker_tick(settings: Settings) -> dict[str, int]:
    now = datetime.now(UTC)
    async with get_session_factory().begin() as session:
        await session.execute(
            update(PushSubscription)
            .where(
                PushSubscription.is_active.is_(True),
                PushSubscription.expires_at <= now,
            )
            .values(is_active=False, last_outcome="expired", subscription_ciphertext=None)
        )
        await session.execute(
            update(PushDelivery)
            .where(
                PushDelivery.status == "queued",
                PushDelivery.created_at < now - timedelta(hours=1),
            )
            .values(status="cancelled", finished_at=now)
        )
        enqueued = await enqueue_due(session, now=now)
        lease = await claim_run(session, now=now)
    if lease is not None:
        await execute_run(lease, settings=settings)
    async with get_session_factory().begin() as session:
        delivery = await claim_delivery(session, now=datetime.now(UTC))
    if delivery is not None:
        await deliver_push(delivery, settings=settings)
    return {
        "enqueued": enqueued,
        "runs": int(lease is not None),
        "deliveries": int(delivery is not None),
    }


async def worker_loop(settings: Settings, status: dict[str, Any]) -> None:
    while True:
        try:
            await worker_tick(settings)
            status.update(state="running", last_tick_at=datetime.now(UTC).isoformat())
        except asyncio.CancelledError:
            status["state"] = "stopped"
            raise
        except Exception:
            status["state"] = "error"
            logger.error("가격 감시 작업 처리에 실패했습니다. 스키마와 연결 상태를 확인하세요")
        await asyncio.sleep(15)
