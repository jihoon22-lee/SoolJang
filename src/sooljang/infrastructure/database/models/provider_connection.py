"""사용자별 제공자 연결. secret은 서버 DB에만 저장하며 sync/export 대상이 아니다."""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class ProviderConnection(Base, EntityMixin):
    __tablename__ = "provider_connection"

    provider_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    config_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    rate_limit_per_min: Mapped[int] = mapped_column(Integer, nullable=False, default=6)
    request_limit_per_day: Mapped[int] = mapped_column(Integer, nullable=False, default=1000)
    required_fields: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    origin_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="manual")
    origin_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), default=None)
    verified_revision: Mapped[int | None] = mapped_column(Integer, default=None)
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_outcome: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")

    __table_args__ = (
        UniqueConstraint(
            "user_id", "origin_kind", "origin_id", name="uq_provider_connection_origin"
        ),
        CheckConstraint("config_revision >= 1", name="positive_revision"),
        CheckConstraint(
            "rate_limit_per_min >= 1 AND request_limit_per_day >= 1", name="positive_limits"
        ),
        Index("ix_provider_connection_user_kind", "user_id", "provider_kind"),
    )


class ProviderCredential(Base, EntityMixin):
    __tablename__ = "provider_credential"

    connection_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("provider_connection.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    secret_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    hint: Mapped[str] = mapped_column(String(4), nullable=False)

    __table_args__ = (
        UniqueConstraint("connection_id", "name", name="uq_provider_credential_name"),
    )
