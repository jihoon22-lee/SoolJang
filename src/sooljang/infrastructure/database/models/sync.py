"""오프라인 동기화 프로토콜 지원 테이블.

`docs/architecture.md` §5 의 서버 측 부속 테이블 3개.

- `outbox_receipt`: outbox 재전송의 멱등성 판정. PK 자체가 idempotency_key 다
- `sync_cursor`: 사용자별 마지막 풀 커서. 부기용일 뿐 — 정합성은 클라이언트가 매 요청에
  보내는 `?since=` 커서에 달려 있다
- `conflict_log`: LWW 충돌에서 진 로컬 변경을 보관해 사용자가 잃어버린 입력을 복구할 수
  있게 한다(§5.4). 다른 9개 동기화 대상 테이블과 같은 방식(`EntityMixin`)으로 풀 대상에
  포함시켜, 한 기기에서 발생한 충돌이 다른 기기의 Dexie 미러에도 같은 배관으로 전파되게
  한다
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class OutboxReceipt(Base):
    """outbox 작업 재전송 판정. PK 가 곧 idempotency_key 다."""

    __tablename__ = "outbox_receipt"

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    entity: Mapped[str] = mapped_column(String(40), nullable=False)
    operation: Mapped[str] = mapped_column(String(20), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    response_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # 30일 보관 정책(§5.2)의 만료 대상을 빠르게 찾기 위함.
        Index("ix_outbox_receipt_user_id_created_at", "user_id", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<OutboxReceipt {self.entity}:{self.operation} status={self.status}>"


class SyncCursor(Base):
    """사용자별 마지막 풀 커서. 부기용 — 클라이언트가 보내는 커서가 실제 기준이다."""

    __tablename__ = "sync_cursor"

    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    cursor: Mapped[str] = mapped_column(Text, nullable=False)
    pulled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    def __repr__(self) -> str:
        return f"<SyncCursor user={self.user_id} pulled_at={self.pulled_at.isoformat()}>"


class ConflictLog(Base, EntityMixin):
    """LWW 충돌에서 진 로컬 변경. 사용자가 확인할 수 있게 보관한다(§5.4)."""

    __tablename__ = "conflict_log"

    entity: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    server_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    client_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    client_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    idempotency_key: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), default=None)

    __table_args__ = (
        Index("ix_conflict_log_user_id_entity_id", "user_id", "entity_id"),
        # 동기화 델타 조회 기준(`docs/architecture.md` §2.4).
        Index("ix_conflict_log_user_id_updated_at", "user_id", "updated_at"),
    )

    def __repr__(self) -> str:
        return f"<ConflictLog {self.entity}:{self.entity_id}>"
