"""외부 소스 레지스트리·조회 API 스키마(Task 18)."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExternalSourceCreate(BaseModel):
    #: 프리셋 카탈로그(`GET /external-sources/presets`)에서 고른 키(Task 34 PR5). 있으면
    #: `base_url`·`adapter_spec` 은 프리셋 값을 그대로 쓰므로 생략할 수 있다.
    preset_key: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_url: str | None = Field(default=None, min_length=1)
    #: `docs/architecture.md` §7.2 스키마와 같은 모양의 JSON. 형식 검증은 조회 시점에
    #: `infrastructure/external/adapter.py` 가 각 필드를 관대하게 읽으며 수행한다 — 등록
    #: 단계에서 엄격한 스키마 검증을 두면 사이트 구조가 조금만 달라도 등록 자체가 막힌다.
    #: `preset_key` 가 없으면 필수다.
    adapter_spec: dict[str, Any] | None = None
    category_id: uuid.UUID | None = None
    priority: int = 0
    is_active: bool = True
    rate_limit_per_min: int = Field(default=6, ge=1, le=60)
    ttl_hours: int = Field(default=24, ge=1, le=24 * 30)
    note: str | None = None

    @model_validator(mode="after")
    def _require_custom_fields_without_preset(self) -> Self:
        if self.preset_key is None:
            missing = [
                field
                for field, value in (("name", self.name), ("base_url", self.base_url))
                if value is None
            ]
            if self.adapter_spec is None:
                missing.append("adapter_spec")
            if missing:
                raise ValueError(f"preset_key 가 없으면 다음이 필요합니다: {', '.join(missing)}")
        return self


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
    #: 이 소스를 만든 프리셋의 키. 커스텀 등록이면 `None`(Task 34 PR5).
    preset_key: str | None = None
    preset_version: int | None = None
    #: 사용자가 `adapter_spec` 을 직접 편집해 프리셋 자동 갱신 대상에서 빠졌는지.
    spec_overridden: bool = False
    #: 저장된 자격 증명의 이름→마스킹 힌트. 원문은 절대 담기지 않는다. 라우터가 별도
    #: 조회로 채운다 — `ExternalSource` ORM 모델의 속성이 아니다.
    credential_hints: dict[str, str] = Field(default_factory=dict)


class SourcePresetOut(BaseModel):
    """프리셋 카탈로그 항목 하나(Task 34 PR5). `adapter_spec` 은 노출하지 않는다 —
    등록 시점에 서버가 채워 넣을 뿐, 사용자가 미리 볼 필요가 없는 구현 세부사항이다."""

    key: str
    name: str
    base_url: str
    description: str
    category_hint: str | None
    requires_credentials: bool
    version: int


class SourceCredentialsIn(BaseModel):
    """소스에 필요한 자격 증명을 일괄 저장한다(Task 34 PR5). 이름→원문 값."""

    values: dict[str, str] = Field(min_length=1)


class SourceCredentialsOut(BaseModel):
    #: 이름→마스킹 힌트. 원문은 응답에 절대 담기지 않는다.
    hints: dict[str, str]


class LookupCandidateOut(BaseModel):
    """검색 결과 후보 하나. 사용자가 이 중 하나를 골라 고정할 수 있다(Task 34 PR1)."""

    name: str
    url: str
    key: str | None
    score: float


class NormalizedFieldsOut(BaseModel):
    """`fields` 를 표준 키로 분류하고 파생값을 계산한 결과(Task 34 PR3).

    비교 뷰(최저가·100ml당 가격)가 이 값을 쓴다. `rating_normalized`·`price_per_100ml`
    은 응답을 조립할 때 매번 계산되며 DB 에는 저장되지 않는다(절대 규칙 6).
    """

    price_krw: int | None
    list_price_krw: int | None
    currency: str
    volume_ml: int | None
    rating: float | None
    rating_scale: float | None
    #: 평점을 5점 만점으로 환산. 척도를 모르면 `None`.
    rating_normalized: Decimal | None
    review_count: int | None
    in_stock: bool | None
    #: 100ml당 가격. 용량을 모르면 `None`(0 나눗셈 방지).
    price_per_100ml: Decimal | None
    #: 표준 키가 아닌 값. 소스가 표준 키로 안 바뀌어도 값이 사라지지 않는다.
    extra: dict[str, Any]


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
    #: 실제로 매칭된 상품명과 그 점수. 값이 있어도 이 이름이 엉뚱하면 사용자가 바로
    #: 알아채고 고칠 수 있어야 한다는 것이 Task 34 PR1 의 요지다.
    matched_name: str | None = None
    match_score: float | None = None
    #: 점수가 자동 채택 구간에 못 미쳐 사용자 확인이 필요한지.
    needs_confirmation: bool = False
    #: 사용자가 고정해 둔 매칭으로 조회한 결과인지.
    pinned: bool = False
    candidates: list[LookupCandidateOut] = Field(default_factory=list)
    #: 비교 뷰용 표준 필드(Task 34 PR3).
    normalized: NormalizedFieldsOut
    #: LLM 이 애매 구간에서 추천한 후보의 URL(Task 34 PR6). `candidates` 안의 항목 중
    #: 하나를 가리킨다 — 화면이 "LLM 추천" 배지만 붙일 뿐 자동으로 고정하지 않는다.
    llm_recommended_url: str | None = None


class ExternalProductMatchCreate(BaseModel):
    """ "이 제품 = 이 소스의 이 상품" 고정 요청."""

    source_id: uuid.UUID
    external_url: str = Field(min_length=1)
    external_name: str = Field(min_length=1)
    external_key: str | None = Field(default=None, max_length=200)


class ExternalProductMatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source_id: uuid.UUID
    product_id: uuid.UUID
    external_url: str
    external_name: str
    external_key: str | None
    confirmed_at: datetime


class SourceHealthOut(BaseModel):
    """소스 하나의 최근 조회 이력 요약(Task 34 PR4)."""

    source_id: uuid.UUID
    source_name: str
    #: "healthy"(정상) | "degraded"(부분 실패) | "failing"(연속 실패) | "unknown"(이력 없음)
    status: str
    last_success_at: datetime | None
    consecutive_failures: int
    last_warning: str | None


class SourceProbeRequest(BaseModel):
    """헬스 화면의 "테스트 조회" 요청. 실제 소유한 제품이 아닌 샘플 이름으로 조회한다."""

    name: str = Field(min_length=1, max_length=200)


class SourceProbeOut(BaseModel):
    """테스트 조회 결과. 값은 화면에만 보여줄 뿐 캐시에는 저장되지 않는다."""

    ok: bool
    degraded: bool
    warning: str | None
    matched_name: str | None
    match_score: float | None
