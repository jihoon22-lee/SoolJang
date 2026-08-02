"""LLM 설정 API 스키마."""

from datetime import datetime

from pydantic import BaseModel, Field

from sooljang.infrastructure.database.models import DEFAULT_OPENAI_MODEL, LlmProvider


class LlmSettingIn(BaseModel):
    """설정 저장 요청. `api_key` 는 응답으로 절대 되돌아오지 않는다."""

    provider: LlmProvider = LlmProvider.OPENAI
    api_key: str = Field(min_length=10, max_length=500)
    model: str = Field(default=DEFAULT_OPENAI_MODEL, min_length=1, max_length=100)


class LlmSettingOut(BaseModel):
    """현재 설정 상태. `api_key` 원문은 절대 포함하지 않는다 — 마스킹된 값만 준다."""

    configured: bool
    provider: LlmProvider | None = None
    model: str | None = None
    api_key_masked: str | None = None
    updated_at: datetime | None = None
