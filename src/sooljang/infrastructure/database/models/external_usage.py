"""프로세스 재시작·동시 요청에도 유지되는 외부 호출 예약 카운터."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base


class ExternalRequestUsage(Base):
    """소스/공유 연결의 시간 구간별 요청 예약 수. 자격증명이나 질의는 저장하지 않는다.

    실제 송신 직전 예약을 별도 트랜잭션으로 커밋한다. 장애/취소 시 보수적으로 소비한
    예약을 유지하므로 제공자 과금/잔액과 동일한 값으로 표시하면 안 된다.
    """

    __tablename__ = "external_request_usage"

    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    scope_kind: Mapped[str] = mapped_column(String(20), primary_key=True)
    scope_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    window_kind: Mapped[str] = mapped_column(String(10), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    reserved_count: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint("scope_kind IN ('source', 'connection')", name="valid_scope"),
        CheckConstraint("window_kind IN ('minute', 'day')", name="valid_window"),
        CheckConstraint("reserved_count >= 0", name="nonnegative_count"),
    )
