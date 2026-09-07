"""온라인 정리·보관·실사 기록. 기존 병과 자유 입력 위치는 그대로 보존한다."""

import datetime
import uuid
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class StorageLocation(Base, EntityMixin):
    __tablename__ = "storage_location"

    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(24), default="shelf")
    note: Mapped[str | None] = mapped_column(Text, default=None)


class BottlePlacement(Base, EntityMixin):
    __tablename__ = "bottle_placement"

    bottle_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("bottle.id"))
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID, ForeignKey("storage_location.id"), default=None
    )
    __table_args__ = (UniqueConstraint("bottle_id"),)


class BottleMovement(Base, EntityMixin):
    __tablename__ = "bottle_movement"

    bottle_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("bottle.id"))
    from_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID, ForeignKey("storage_location.id"), default=None
    )
    to_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID, ForeignKey("storage_location.id"), default=None
    )


class Stocktake(Base, EntityMixin):
    __tablename__ = "stocktake"

    name: Mapped[str] = mapped_column(String(200))
    location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID, ForeignKey("storage_location.id"), default=None
    )
    status: Mapped[str] = mapped_column(String(24), default="active")
    expected: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    observations: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    found_notes: Mapped[list[str]] = mapped_column(JSONB, default=list)


class CleanupPreview(Base, EntityMixin):
    __tablename__ = "cleanup_preview"

    kind: Mapped[str] = mapped_column(String(40))
    selection: Mapped[dict[str, Any]] = mapped_column(JSONB)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)
    confirmed_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True))


class InterestConversion(Base, EntityMixin):
    """관심 한 건의 구매 전환 결과. 재전송으로 새 구매를 만들지 않는다."""

    __tablename__ = "interest_conversion"

    interest_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("interest.id"))
    purchase_id: Mapped[uuid.UUID] = mapped_column(UUID, ForeignKey("purchase.id"))
    request_hash: Mapped[str] = mapped_column(String(64))
    __table_args__ = (UniqueConstraint("interest_id"),)
