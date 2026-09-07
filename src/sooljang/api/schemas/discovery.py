"""새 탐색은 식별 속성만 입력받는다. 자유 provider 옵션이나 개인 이력은 받지 않는다."""

import uuid
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from sooljang.api.schemas.interests import InterestIdentity, InterestSourceMatch


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: uuid.UUID
    query: str = Field(min_length=1, max_length=300)
    page: int = Field(default=1, ge=1, le=3)
    language: Literal["ko", "en", "ja", "zh-hans"] = "ko"

    @field_validator("query")
    @classmethod
    def query_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("검색명을 입력하세요")
        return value.strip()


class IdentityLookupInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    identity: InterestIdentity
    source_ids: list[uuid.UUID] = Field(min_length=1, max_length=4)
    source_matches: dict[uuid.UUID, InterestSourceMatch] = Field(default_factory=dict, max_length=4)


class InterestLookupInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_ids: list[uuid.UUID] = Field(min_length=1, max_length=4)


class ApplyEvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: uuid.UUID
    expected_updated_at: AwareDatetime
    evidence_token: str = Field(min_length=1, max_length=16000)
    selected_fields: list[
        Literal["name_en", "country", "region", "abv", "vintage", "age_years"]
    ] = Field(min_length=1, max_length=6)
