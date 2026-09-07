"""연결 설정 전용 스키마. 쓰기 요청의 SecretStr는 어떤 응답에도 포함하지 않는다."""

import uuid
from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from sooljang.domain.discovery import SourceOutcome

CredentialValue = Annotated[SecretStr, Field(max_length=4000)]

ProviderKind = Literal[
    "naver_hub", "naver_legacy", "brave", "exa", "openai_ocr", "dailyshot", "source"
]


class CredentialFieldOut(BaseModel):
    name: str
    label: str
    saved: bool = False
    masked_hint: str | None = None


class ProviderDefinitionOut(BaseModel):
    kind: ProviderKind
    label: str
    fields: list[CredentialFieldOut]
    features: list[str]
    guide_url: str
    note: str
    probe_supported: bool


class ConnectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_kind: ProviderKind
    name: str = Field(default="", max_length=200)
    credentials: dict[str, CredentialValue] = Field(default_factory=dict, max_length=20)


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)


class ConnectionUpdate(RevisionRequest):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_active: bool | None = None
    rate_limit_per_min: int | None = Field(default=None, ge=1, le=60)
    request_limit_per_day: int | None = Field(default=None, ge=1, le=100000)
    credentials: dict[str, CredentialValue] = Field(default_factory=dict, max_length=20)
    delete_credentials: list[str] = Field(default_factory=list, max_length=20)
    ocr_model: str | None = Field(default=None, min_length=1, max_length=100)
    ocr_rematch_enabled: bool | None = None
    ocr_rematch_monthly_cap: int | None = Field(default=None, ge=1, le=100000)

    @model_validator(mode="after")
    def reject_null(self) -> Self:
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("설정 항목은 null일 수 없습니다")
        return self


class ConnectionSourceOut(BaseModel):
    id: uuid.UUID
    name: str
    is_active: bool


class ProviderConnectionOut(BaseModel):
    id: uuid.UUID
    provider_kind: ProviderKind
    name: str
    is_active: bool
    config_revision: int
    rate_limit_per_min: int
    request_limit_per_day: int
    registration: Literal[
        "unregistered", "incomplete", "saved", "not_required", "recovery_required"
    ]
    credential_fields: list[CredentialFieldOut]
    missing_fields: list[str]
    origin_kind: str
    updated_at: datetime
    verified_revision: int | None
    last_test_at: datetime | None
    last_outcome: SourceOutcome
    verification_stale: bool
    features: list[str]
    sources: list[ConnectionSourceOut]
    usage: dict[str, int]
    provider_remaining: None = None
    ocr_model: str
    ocr_rematch_enabled: bool
    ocr_rematch_monthly_cap: int


class ConnectionProbeOut(BaseModel):
    outcome: SourceOutcome
    tested_revision: int
    applied: bool
