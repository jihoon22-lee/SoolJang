"""기록 변경 이력. 병 상태 전이·구매 수정이 언제 어떻게 바뀌었는지 남긴다.

병 위치 이동(`BottleMovement`)처럼 사실을 덮어쓰지 않고 쌓는다. 실행 취소·실수 확인과
"이 병이 언제 열렸다가 다시 닫혔나" 같은 질문에 답하기 위한 감사 기록이며, 파생값이
아니라 재계산할 수 없는 1차 사실이라 저장한다.
"""

import uuid
from typing import Any

from sqlalchemy import Index, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class RecordEvent(Base, EntityMixin):
    __tablename__ = "record_event"

    #: "bottle" | "purchase"
    entity: Mapped[str] = mapped_column(String(24))
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    #: 병: open/finish/gift/sell/reopen/unopen/set_remaining/tasting, 구매: update/resize
    action: Mapped[str] = mapped_column(String(32))
    #: 바뀐 값 요약. 예: {"status": ["unopened", "open"], "on": "2026-10-05"}
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)

    __table_args__ = (
        Index("ix_record_event_entity", "user_id", "entity", "entity_id", "created_at"),
    )
