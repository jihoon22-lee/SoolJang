"""관심 대상 가격 감시·실행 occurrence·논리 알림·푸시 전달을 서버에 영속화한다."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class PriceWatch(Base, EntityMixin):
    __tablename__ = "price_watch"

    interest_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("interest.id", ondelete="CASCADE")
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_source.id", ondelete="CASCADE")
    )
    condition_key: Mapped[str] = mapped_column(String(64))
    criteria: Mapped[dict[str, Any]] = mapped_column(JSONB)
    config_revision: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    schedule_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    push_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    interval_seconds: Mapped[int] = mapped_column(Integer, default=86400)
    cooldown_seconds: Mapped[int] = mapped_column(Integer, default=86400)
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_outcome: Mapped[str] = mapped_column(String(40), default="unknown")
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_notified_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), default=None)
    last_satisfied: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (
        Index(
            "uq_price_watch_condition",
            "user_id",
            "interest_id",
            "source_id",
            "condition_key",
            unique=True,
            postgresql_where="deleted_at IS NULL",
        ),
        Index(
            "ix_price_watch_due",
            "next_due_at",
            postgresql_where="deleted_at IS NULL AND is_active AND schedule_enabled",
        ),
        CheckConstraint("config_revision >= 1", name="positive_revision"),
        CheckConstraint("interval_seconds BETWEEN 900 AND 604800", name="bounded_interval"),
        CheckConstraint("cooldown_seconds BETWEEN 900 AND 604800", name="bounded_cooldown"),
    )


class PriceWatchRun(Base):
    __tablename__ = "price_watch_run"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), index=True)
    watch_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("price_watch.id", ondelete="CASCADE")
    )
    occurrence_key: Mapped[str] = mapped_column(String(100))
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    watch_revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), default=None)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    outcome: Mapped[str] = mapped_column(String(40), default="unknown")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    __table_args__ = (
        UniqueConstraint("watch_id", "occurrence_key", name="uq_price_watch_occurrence"),
        Index("ix_price_watch_run_queue", "status", "available_at"),
        CheckConstraint("attempts BETWEEN 0 AND 3", name="bounded_attempts"),
        CheckConstraint(
            "status IN ('queued','running','succeeded','skipped','failed','cancelled')",
            name="valid_status",
        ),
    )


class PriceNotification(Base):
    __tablename__ = "price_notification"

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), index=True)
    watch_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("price_watch.id", ondelete="SET NULL")
    )
    interest_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("interest.id", ondelete="SET NULL")
    )
    observation_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_price_observation.id", ondelete="SET NULL")
    )
    watch_revision: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    __table_args__ = (
        UniqueConstraint("watch_id", "observation_id", name="uq_price_notification_observation"),
    )


class PushSubscription(Base, EntityMixin):
    __tablename__ = "push_subscription"

    endpoint_hash: Mapped[str] = mapped_column(String(64))
    subscription_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, default=None)
    vapid_key_id: Mapped[str] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_outcome: Mapped[str] = mapped_column(String(20), default="registered")

    __table_args__ = (
        Index(
            "uq_push_subscription_endpoint",
            "endpoint_hash",
            unique=True,
            postgresql_where="deleted_at IS NULL",
        ),
    )


class PushDelivery(Base):
    __tablename__ = "push_delivery"

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), index=True)
    notification_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("price_notification.id", ondelete="CASCADE")
    )
    subscription_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("push_subscription.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(String(20), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), default=None)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

    __table_args__ = (
        UniqueConstraint("notification_id", "subscription_id", name="uq_push_delivery_event"),
        Index("ix_push_delivery_queue", "status", "available_at"),
        CheckConstraint("attempts BETWEEN 0 AND 3", name="bounded_attempts"),
        CheckConstraint(
            "status IN ('queued','sending','accepted','unknown','rejected',"
            "'expired','cancelled','blocked','queue_full')",
            name="valid_status",
        ),
    )
