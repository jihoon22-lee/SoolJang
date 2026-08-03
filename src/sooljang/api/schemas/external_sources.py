"""외부 소스 레지스트리·조회 API 스키마(Task 18)."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ExternalSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    base_url: str = Field(min_length=1)
    #: `docs/architecture.md` §7.2 스키마와 같은 모양의 JSON. 형식 검증은 조회 시점에
    #: `infrastructure/external/adapter.py` 가 각 필드를 관대하게 읽으며 수행한다 — 등록
    #: 단계에서 엄격한 스키마 검증을 두면 사이트 구조가 조금만 달라도 등록 자체가 막힌다.
    adapter_spec: dict[str, Any]
    category_id: uuid.UUID | None = None
    priority: int = 0
    is_active: bool = True
    rate_limit_per_min: int = Field(default=6, ge=1, le=60)
    ttl_hours: int = Field(default=24, ge=1, le=24 * 30)
    note: str | None = None


class ExternalSourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_url: str | None = Field(default=None, min_length=1)
    adapter_spec: dict[str, Any] | None = None
    category_id: uuid.UUID | None = None
    priority: int | None = None
    is_active: bool | None = None
    rate_limit_per_min: int | None = Field(default=None, ge=1, le=60)
    ttl_hours: int | None = Field(default=None, ge=1, le=24 * 30)
    note: str | None = None


class ExternalSourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    base_url: str
    adapter_spec: dict[str, Any]
    category_id: uuid.UUID | None
    priority: int
    is_active: bool
    rate_limit_per_min: int
    ttl_hours: int
    note: str | None


class SourceLookupOut(BaseModel):
    """소스 하나의 조회 결과. `degraded` 면 `fields` 가 일부만 채워졌을 수 있다."""

    source_id: uuid.UUID
    source_name: str
    cached: bool
    source_url: str | None
    fields: dict[str, Any]
    raw_excerpt: str | None
    degraded: bool
    warning: str | None
    fetched_at: datetime | None
