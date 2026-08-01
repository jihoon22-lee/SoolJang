"""오프라인 동기화 API 스키마.

`fields` 를 엔티티별 전용 스키마로 나누지 않고 `dict[str, Any]` 로 느슨하게 받는다.
검증은 `application/sync.py` 의 각 디스패치 함수가 한다 — 엔티티 11개 조합마다 스키마를
새로 만드는 비용을 피하면서도, 실제 필드 해석은 도메인 로직과 한곳에 둔다.
"""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class SyncOperationIn(BaseModel):
    """outbox 작업 하나. `docs/architecture.md` §5.2."""

    idempotency_key: uuid.UUID
    entity: str
    op: str = Field(description="create | update | delete | action")
    entity_id: uuid.UUID
    #: update 의 LWW 판정 기준. 없으면 항상 적용한다.
    base_updated_at: datetime | None = None
    #: op 가 "action" 일 때만 쓴다 (예: open/finish/gift/sell/reopen/record_tasting).
    action: str | None = None
    fields: dict[str, Any] = Field(default_factory=dict)


class SyncBatchIn(BaseModel):
    operations: list[SyncOperationIn] = Field(min_length=1, max_length=200)


class SyncOperationResultOut(BaseModel):
    idempotency_key: uuid.UUID
    status: str = Field(description="applied | conflict | failed")
    detail: str | None = None
    snapshot: dict[str, Any] | None = None


class SyncBatchOut(BaseModel):
    results: list[SyncOperationResultOut]
    #: True 면 실패한 작업 이후를 서버가 적용하지 않았다는 뜻이다. 클라이언트는 실패한
    #: 작업부터 다시 큐에 남겨 두고 나머지는 재전송하지 않는다.
    stopped: bool


class SyncPullOut(BaseModel):
    """`docs/architecture.md` §5.3 응답 형태."""

    changes: dict[str, list[dict[str, Any]]]
    next_cursor: str | None
    has_more: bool
