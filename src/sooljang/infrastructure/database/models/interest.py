"""관심 제품의 안정적인 식별자. 구매 전환 뒤에도 관측·모니터링 참조를 보존한다."""

import datetime
import uuid
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class Interest(Base, EntityMixin):
    __tablename__ = "interest"

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    identity: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    source_matches: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    archived_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID, ForeignKey("product.id", ondelete="SET NULL"), default=None
    )
