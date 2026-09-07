"""외부 제품 아래 판매 조건과 실제 가격 관측. 파생 최저가는 저장하지 않는다."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class ExternalOffer(Base, EntityMixin):
    __tablename__ = "external_offer"

    source_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_source.id", ondelete="CASCADE")
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("product.id", ondelete="CASCADE")
    )
    external_product_key: Mapped[str] = mapped_column(Text)
    external_offer_key: Mapped[str] = mapped_column(Text)
    condition_key: Mapped[str] = mapped_column(String(64))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index(
            "uq_external_offer_condition", "source_id", "product_id", "condition_key", unique=True
        ),
        Index("ix_external_offer_user_product", "user_id", "product_id"),
    )


class ExternalPriceObservation(Base):
    __tablename__ = "external_price_observation"

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
    )
    offer_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("external_offer.id", ondelete="CASCADE")
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    currency: Mapped[str] = mapped_column(String(3))
    source_url: Mapped[str] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    facts: Mapped[dict[str, Any]] = mapped_column(JSONB)

    __table_args__ = (
        Index("uq_external_price_acquisition", "offer_id", "fetched_at", unique=True),
        Index("ix_external_price_user_time", "user_id", "fetched_at"),
        CheckConstraint("amount >= 0", name="nonnegative_amount"),
    )
