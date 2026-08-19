"""외부 소스 레지스트리·조회 API 스키마(Task 18, 매칭 고정은 Task 34 PR1)."""

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


class LookupCandidateOut(BaseModel):
    """조회 결과에 함께 온 후보 하나. `url` 을 그대로 `ExternalProductMatchCreate.external_url`
    에 넣어 고정할 수 있다."""

    name: str
    url: str
    key: str | None
    score: float


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
    #: 실제로 선택된 후보의 이름·점수. 고정 조회로 검색 자체를 건너뛴 경우 점수는 없다.
    matched_name: str | None = None
    match_score: float | None = None
    #: `True` 면 화면이 후보 목록을 펼쳐 보여주고 확인을 유도해야 한다. 고정된 조회는
    #: 항상 `False` 다.
    needs_confirmation: bool = False
    #: 이 소스에 이 제품이 고정돼 있는지.
    pinned: bool = False
    #: 점수 내림차순, 최대 5개. 검색을 건너뛴 고정 조회는 빈 리스트다.
    candidates: list[LookupCandidateOut] = Field(default_factory=list)


class ExternalProductMatchCreate(BaseModel):
    """제품과 소스의 특정 URL 이 같은 상품이라는 고정 요청. 조회 결과의 후보 하나를 그대로
    옮겨 담는다."""

    source_id: uuid.UUID
    external_url: str = Field(min_length=1)
    external_name: str = Field(min_length=1)
    external_key: str | None = None


class ExternalProductMatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_id: uuid.UUID
    product_id: uuid.UUID
    external_url: str
    external_name: str
    external_key: str | None
    confirmed_at: datetime
