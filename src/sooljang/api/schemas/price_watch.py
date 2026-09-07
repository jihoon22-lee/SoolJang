"""가격 감시·푸시 구독 입력. 구독 주소/키를 일반 응답에 포함하지 않는다."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

Amount = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4, allow_inf_nan=False)]


class WatchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interest_id: uuid.UUID
    offer_id: uuid.UUID
    target_amount: Amount
    max_age_seconds: int = Field(default=3600, ge=60, le=86400)


class WatchRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)


class WatchUpdate(WatchRevision):
    target_amount: Amount | None = None
    max_age_seconds: int | None = Field(default=None, ge=60, le=86400)
    is_active: bool | None = None
    schedule_enabled: bool | None = None
    push_enabled: bool | None = None
    interval_seconds: int | None = Field(default=None, ge=900, le=604800)
    cooldown_seconds: int | None = Field(default=None, ge=900, le=604800)

    @model_validator(mode="after")
    def reject_null(self) -> Self:
        if any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("설정 항목은 null일 수 없습니다")
        return self


class WatchCheck(WatchRevision):
    request_id: uuid.UUID


class SubscriptionKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p256dh: Annotated[SecretStr, Field(max_length=256)]
    auth: Annotated[SecretStr, Field(max_length=256)]


class SubscriptionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: Annotated[SecretStr, Field(max_length=4096)]
    keys: SubscriptionKeys
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def require_timezone(self) -> Self:
        if self.expires_at is not None and self.expires_at.tzinfo is None:
            raise ValueError("구독 만료 시각에는 시간대가 필요합니다")
        return self
