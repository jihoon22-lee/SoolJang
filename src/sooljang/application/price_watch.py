"""가격 감시 설정과 사용자 소유 이력/구독. 외부 조회는 worker 경계에서만 수행한다."""

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.config import Settings
from sooljang.domain.price_watch import CONDITION_FIELDS, WatchCriteria
from sooljang.infrastructure.database.models import (
    ExternalOffer,
    ExternalPriceObservation,
    ExternalSource,
    Interest,
    Product,
    ProviderConnection,
    ProviderCredential,
)
from sooljang.infrastructure.database.models.price_watch import (
    PriceNotification,
    PriceWatch,
    PriceWatchRun,
    PushDelivery,
    PushSubscription,
)
from sooljang.infrastructure.security.secrets import encrypt_secret
from sooljang.infrastructure.web_push import validate_subscription, vapid_public_key

MAX_WATCHES = 100
MAX_SUBSCRIPTIONS = 5


def watch_criteria(watch: PriceWatch) -> WatchCriteria:
    data = watch.criteria
    return WatchCriteria(
        product_key=data["product_key"],
        offer_key=data["offer_key"],
        condition_key=watch.condition_key,
        currency=data["currency"],
        volume_ml=Decimal(data["volume_ml"]),
        units=data["units"],
        target_amount=Decimal(data["target_amount"]),
        conditions=data["conditions"],
        max_age_seconds=data["max_age_seconds"],
    )


async def owned_interest(
    session: AsyncSession, *, user_id: uuid.UUID, interest_id: uuid.UUID
) -> Interest:
    interest = await session.scalar(
        select(Interest).where(
            Interest.id == interest_id, Interest.user_id == user_id, Interest.deleted_at.is_(None)
        )
    )
    if interest is None:
        raise NotFoundError("관심 대상을 찾을 수 없습니다")
    return interest


async def owned_watch(
    session: AsyncSession, *, user_id: uuid.UUID, watch_id: uuid.UUID, lock: bool = False
) -> PriceWatch:
    statement = select(PriceWatch).where(
        PriceWatch.id == watch_id, PriceWatch.user_id == user_id, PriceWatch.deleted_at.is_(None)
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    watch = await session.scalar(statement)
    if watch is None:
        raise NotFoundError("가격 감시를 찾을 수 없습니다")
    return watch


async def blocking_reason(session: AsyncSession, watch: PriceWatch) -> str | None:
    if watch.deleted_at is not None or not watch.is_active:
        return "paused"
    interest = await session.scalar(
        select(Interest)
        .where(
            Interest.id == watch.interest_id,
            Interest.user_id == watch.user_id,
            Interest.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    if interest is None or interest.archived_at is not None:
        return "interest_archived"
    pinned = interest.source_matches.get(str(watch.source_id), {})
    if not isinstance(pinned, dict) or not (
        pinned.get("product_key") == watch.criteria["product_key"]
        or (
            pinned.get("product_key") is None
            and pinned.get("external_key") == watch.criteria["offer_key"]
        )
    ):
        return "product_unpinned"
    source = await session.scalar(
        select(ExternalSource)
        .where(
            ExternalSource.id == watch.source_id,
            ExternalSource.user_id == watch.user_id,
            ExternalSource.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    if source is None or not source.is_active:
        return "source_unavailable"
    if not source.price_history_allowed:
        return "history_not_allowed"
    if source.connection_id is not None:
        connection = await session.scalar(
            select(ProviderConnection)
            .where(
                ProviderConnection.id == source.connection_id,
                ProviderConnection.user_id == watch.user_id,
                ProviderConnection.deleted_at.is_(None),
            )
            .execution_options(populate_existing=True)
        )
        if connection is None or not connection.is_active:
            return "connection_unavailable"
        saved_names = set(
            await session.scalars(
                select(ProviderCredential.name).where(
                    ProviderCredential.connection_id == connection.id,
                    ProviderCredential.user_id == watch.user_id,
                    ProviderCredential.deleted_at.is_(None),
                )
            )
        )
        if set(connection.required_fields) - saved_names:
            return "credential_unavailable"
    return None


async def create_watch(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    interest_id: uuid.UUID,
    offer_id: uuid.UUID,
    target_amount: Decimal,
    max_age_seconds: int = 3600,
) -> PriceWatch:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(757170129, :owner)"), {"owner": user_id.int & 0x7FFFFFFF}
    )
    interest = await owned_interest(session, user_id=user_id, interest_id=interest_id)
    if interest.archived_at is not None:
        raise ConflictError("보관한 관심 대상은 먼저 다시 사용하도록 바꾸세요")
    count = await session.scalar(
        select(func.count())
        .select_from(PriceWatch)
        .where(PriceWatch.user_id == user_id, PriceWatch.deleted_at.is_(None))
    )
    if count is not None and count >= MAX_WATCHES:
        raise ConflictError("가격 감시는 계정당 100개까지 등록할 수 있습니다")
    offer = await session.scalar(
        select(ExternalOffer).where(
            ExternalOffer.id == offer_id,
            ExternalOffer.user_id == user_id,
            ExternalOffer.interest_id == interest_id,
            ExternalOffer.deleted_at.is_(None),
        )
    )
    if offer is None:
        raise NotFoundError("이 관심 대상의 판매 조건을 찾을 수 없습니다")
    source = await session.scalar(
        select(ExternalSource).where(
            ExternalSource.id == offer.source_id,
            ExternalSource.user_id == user_id,
            ExternalSource.deleted_at.is_(None),
        )
    )
    if source is None or not source.price_history_allowed:
        raise ConflictError("가격 이력 보관이 허용된 소스만 감시할 수 있습니다")
    observation = await session.scalar(
        select(ExternalPriceObservation)
        .where(
            ExternalPriceObservation.offer_id == offer_id,
            ExternalPriceObservation.user_id == user_id,
        )
        .order_by(ExternalPriceObservation.fetched_at.desc())
        .limit(1)
    )
    if observation is None:
        raise ConflictError("실제 가격을 먼저 조회한 뒤 판매 조건을 선택하세요")
    facts = observation.facts
    values = {
        "product_key": offer.external_product_key,
        "offer_key": offer.external_offer_key,
        "currency": observation.currency,
        "volume_ml": str(facts.get("volume_ml")),
        "units": facts.get("units"),
        "target_amount": str(target_amount),
        "conditions": {key: facts.get(key) for key in CONDITION_FIELDS},
        "max_age_seconds": max_age_seconds,
    }
    watch = PriceWatch(
        user_id=user_id,
        interest_id=interest_id,
        source_id=offer.source_id,
        condition_key=offer.condition_key,
        criteria=values,
    )
    try:
        if (
            facts.get("is_set") is not False
            or not isinstance(values["units"], int)
            or isinstance(values["units"], bool)
        ):
            raise ValueError("단품 규격과 판매 수량을 확인하세요")
        watch_criteria(watch)
    except ValueError, ArithmeticError, TypeError:
        raise ValidationFailedError(
            "용량·수량·회원·쿠폰·배송·세금·지역 조건이 확인된 단품을 선택하세요"
        ) from None
    existing = await session.scalar(
        select(PriceWatch.id).where(
            PriceWatch.user_id == user_id,
            PriceWatch.interest_id == interest_id,
            PriceWatch.source_id == offer.source_id,
            PriceWatch.condition_key == offer.condition_key,
            PriceWatch.deleted_at.is_(None),
        )
    )
    if existing is not None:
        raise ConflictError("같은 판매 조건의 가격 감시가 이미 있습니다")
    session.add(watch)
    await session.flush()
    return watch


async def update_watch(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    watch_id: uuid.UUID,
    expected_revision: int,
    fields: dict[str, Any],
    now: datetime | None = None,
) -> PriceWatch:
    now = now or datetime.now(UTC)
    watch = await owned_watch(session, user_id=user_id, watch_id=watch_id, lock=True)
    if watch.config_revision != expected_revision:
        raise ConflictError("다른 곳에서 감시 설정을 변경했습니다. 최신 상태를 확인하세요")
    if "target_amount" in fields or "max_age_seconds" in fields:
        criteria = dict(watch.criteria)
        if "target_amount" in fields:
            criteria["target_amount"] = str(fields.pop("target_amount"))
        if "max_age_seconds" in fields:
            criteria["max_age_seconds"] = fields.pop("max_age_seconds")
        watch.criteria = criteria
        watch_criteria(watch)
    for field, value in fields.items():
        setattr(watch, field, value)
    watch.config_revision += 1
    watch.next_due_at = (
        now + timedelta(seconds=watch.interval_seconds)
        if watch.is_active and watch.schedule_enabled
        else None
    )
    await session.execute(
        update(PriceWatchRun)
        .where(PriceWatchRun.watch_id == watch_id, PriceWatchRun.status.in_(["queued", "running"]))
        .values(status="cancelled", outcome="configuration_changed", finished_at=now)
    )
    await session.execute(
        update(PushDelivery)
        .where(
            PushDelivery.notification_id.in_(
                select(PriceNotification.id).where(PriceNotification.watch_id == watch_id)
            ),
            PushDelivery.status == "queued",
        )
        .values(status="cancelled", finished_at=now)
    )
    await session.flush()
    return watch


async def remove_watch(
    session: AsyncSession, *, user_id: uuid.UUID, watch_id: uuid.UUID, expected_revision: int
) -> None:
    watch = await update_watch(
        session,
        user_id=user_id,
        watch_id=watch_id,
        expected_revision=expected_revision,
        fields={"is_active": False, "schedule_enabled": False, "push_enabled": False},
    )
    watch.deleted_at = datetime.now(UTC)
    await session.flush()


async def watch_view(session: AsyncSession, watch: PriceWatch) -> dict[str, Any]:
    interest = await session.get(Interest, watch.interest_id)
    source = await session.get(ExternalSource, watch.source_id)
    run = await session.scalar(
        select(PriceWatchRun)
        .where(PriceWatchRun.watch_id == watch.id, PriceWatchRun.user_id == watch.user_id)
        .order_by(PriceWatchRun.created_at.desc(), PriceWatchRun.id.desc())
        .limit(1)
    )
    return {
        "id": watch.id,
        "interest_id": watch.interest_id,
        "interest_name": interest.name if interest is not None else "삭제된 관심 대상",
        "source_id": watch.source_id,
        "source_name": source.name if source is not None else "해제된 소스",
        "condition_key": watch.condition_key,
        "criteria": watch.criteria,
        "config_revision": watch.config_revision,
        "is_active": watch.is_active,
        "schedule_enabled": watch.schedule_enabled,
        "push_enabled": watch.push_enabled,
        "interval_seconds": watch.interval_seconds,
        "cooldown_seconds": watch.cooldown_seconds,
        "next_due_at": watch.next_due_at,
        "last_checked_at": watch.last_checked_at,
        "last_outcome": watch.last_outcome,
        "blocked_reason": await blocking_reason(session, watch),
        "last_notified_at": watch.last_notified_at,
        "latest_run": None if run is None else run_view(run),
    }


def run_view(run: PriceWatchRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "watch_id": run.watch_id,
        "status": run.status,
        "outcome": run.outcome,
        "attempts": run.attempts,
        "scheduled_for": run.scheduled_for,
        "finished_at": run.finished_at,
    }


async def price_history(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    interest_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    before: datetime | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    if (interest_id is None) == (product_id is None):
        raise ValidationFailedError("제품 또는 관심 대상 하나를 선택하세요")
    if interest_id is not None:
        await owned_interest(session, user_id=user_id, interest_id=interest_id)
        target = ExternalOffer.interest_id == interest_id
    else:
        product = await session.scalar(
            select(Product.id).where(
                Product.id == product_id, Product.user_id == user_id, Product.deleted_at.is_(None)
            )
        )
        if product is None:
            raise NotFoundError("제품을 찾을 수 없습니다")
        target = ExternalOffer.product_id == product_id
    if before is not None and before.tzinfo is None:
        raise ValidationFailedError("이력 조회 시각에는 시간대가 필요합니다")
    statement = (
        select(ExternalPriceObservation, ExternalOffer, ExternalSource.name)
        .join(ExternalOffer, ExternalOffer.id == ExternalPriceObservation.offer_id)
        .join(ExternalSource, ExternalSource.id == ExternalOffer.source_id)
        .where(
            ExternalPriceObservation.user_id == user_id,
            ExternalOffer.user_id == user_id,
            ExternalSource.user_id == user_id,
            target,
            ExternalOffer.deleted_at.is_(None),
            ExternalSource.deleted_at.is_(None),
            ExternalSource.price_history_allowed.is_(True),
        )
    )
    if before is not None:
        statement = statement.where(ExternalPriceObservation.fetched_at < before)
    rows = await session.execute(
        statement.order_by(
            ExternalPriceObservation.fetched_at.desc(), ExternalPriceObservation.id.desc()
        ).limit(min(limit, 200))
    )
    return [
        {
            "id": observation.id,
            "offer_id": offer.id,
            "source_id": offer.source_id,
            "source_name": name,
            "condition_key": offer.condition_key,
            "amount": str(observation.amount),
            "currency": observation.currency,
            "source_url": observation.source_url,
            "fetched_at": observation.fetched_at,
            "facts": observation.facts,
        }
        for observation, offer, name in rows
    ]


def push_configuration(settings: Settings) -> dict[str, Any]:
    try:
        public = (
            vapid_public_key(settings.push_vapid_private_key)
            if settings.push_vapid_private_key
            and settings.push_vapid_subject.startswith(("mailto:", "https://"))
            and len(settings.push_vapid_subject) <= 256
            else None
        )
    except ValueError:
        public = None
    return {
        "configured": public is not None,
        "public_key": public,
        "worker_enabled": settings.price_watch_worker_enabled,
    }


async def register_subscription(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    endpoint: str,
    p256dh: str,
    auth: str,
    expires_at: datetime | None,
    settings: Settings,
) -> PushSubscription:
    configuration = push_configuration(settings)
    if not configuration["configured"]:
        raise ConflictError("서버의 웹 푸시 설정이 준비되지 않았습니다")
    try:
        values = validate_subscription(
            endpoint, p256dh, auth, allowed_hosts=settings.push_allowed_hosts
        )
    except ValueError:
        raise ValidationFailedError("푸시 구독 주소와 키를 확인하세요") from None
    if expires_at is not None and expires_at <= datetime.now(UTC):
        raise ValidationFailedError("만료된 구독은 새로 등록하세요")
    await session.execute(
        text("SELECT pg_advisory_xact_lock(757170129, :owner)"), {"owner": user_id.int & 0x7FFFFFFF}
    )
    fingerprint = hashlib.sha256(values["endpoint"].encode()).hexdigest()
    await session.execute(
        text("SELECT pg_advisory_xact_lock(757170130, :endpoint)"),
        {"endpoint": int(fingerprint[:8], 16) & 0x7FFFFFFF},
    )
    existing = await session.scalar(
        select(PushSubscription)
        .where(PushSubscription.endpoint_hash == fingerprint, PushSubscription.deleted_at.is_(None))
        .with_for_update()
    )
    if existing is not None and existing.user_id != user_id:
        raise ConflictError("이 브라우저의 이전 구독을 해제한 뒤 새로 등록하세요")
    if existing is None:
        count = await session.scalar(
            select(func.count())
            .select_from(PushSubscription)
            .where(
                PushSubscription.user_id == user_id,
                PushSubscription.deleted_at.is_(None),
                PushSubscription.is_active.is_(True),
                PushSubscription.vapid_key_id
                == hashlib.sha256(configuration["public_key"].encode()).hexdigest(),
                or_(
                    PushSubscription.expires_at.is_(None),
                    PushSubscription.expires_at > datetime.now(UTC),
                ),
            )
        )
        if count is not None and count >= MAX_SUBSCRIPTIONS:
            raise ConflictError("푸시 수신 기기는 최대 5개입니다. 이전 기기를 먼저 해제하세요")
        existing = PushSubscription(user_id=user_id, endpoint_hash=fingerprint)
        session.add(existing)
    existing.subscription_ciphertext = encrypt_secret(
        json.dumps(values, separators=(",", ":")), master_key=settings.secret_key
    )
    existing.vapid_key_id = hashlib.sha256(configuration["public_key"].encode()).hexdigest()
    existing.is_active = True
    existing.expires_at = expires_at
    existing.last_outcome = "registered"
    await session.flush()
    return existing


async def unsubscribe(
    session: AsyncSession, *, user_id: uuid.UUID, subscription_id: uuid.UUID
) -> None:
    row = await session.scalar(
        select(PushSubscription)
        .where(
            PushSubscription.id == subscription_id,
            PushSubscription.user_id == user_id,
            PushSubscription.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if row is None:
        raise NotFoundError("푸시 구독을 찾을 수 없습니다")
    row.is_active = False
    row.deleted_at = datetime.now(UTC)
    row.subscription_ciphertext = None
    row.last_outcome = "cancelled"
    await session.execute(
        update(PushDelivery)
        .where(PushDelivery.subscription_id == row.id, PushDelivery.status == "queued")
        .values(status="cancelled", finished_at=datetime.now(UTC))
    )
    await session.flush()


def subscription_view(row: PushSubscription, active_key_id: str | None = None) -> dict[str, Any]:
    expired = row.expires_at is not None and row.expires_at <= datetime.now(UTC)
    changed = active_key_id is not None and row.vapid_key_id != active_key_id
    return {
        "id": row.id,
        "endpoint_hash": row.endpoint_hash,
        "is_active": row.is_active and not expired and not changed,
        "expires_at": row.expires_at,
        "last_outcome": "expired" if expired else "vapid_changed" if changed else row.last_outcome,
        "created_at": row.created_at,
    }
