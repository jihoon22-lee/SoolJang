"""관심 기록과 명시적 구매 전환 입력."""

import datetime
import uuid
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator


class InterestIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=300)
    name_en: str | None = Field(default=None, max_length=300)
    producer: str | None = Field(default=None, max_length=200)
    abv: Decimal | None = Field(default=None, ge=0, le=100)
    vintage: int | None = Field(default=None, ge=1800, le=2200)
    age_years: Decimal | None = Field(default=None, ge=0, le=100)
    volumes_ml: list[Annotated[int, Field(gt=0, le=100_000)]] = Field(
        default_factory=list, max_length=20
    )

    @field_validator("name")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("제품 이름을 입력하세요")
        return value.strip()


class InterestSourceMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_key: str | None = Field(default=None, min_length=1, max_length=1000)
    external_url: str = Field(min_length=1, max_length=2000)
    external_key: str | None = Field(default=None, min_length=1, max_length=1000)
    external_name: str = Field(min_length=1, max_length=500)


class InterestCreate(BaseModel):
    request_id: uuid.UUID | None = None
    identity: InterestIdentity
    source_matches: dict[uuid.UUID, InterestSourceMatch] = Field(
        default_factory=dict, max_length=100
    )
    note: str | None = Field(default=None, max_length=5000)


class InterestUpdate(BaseModel):
    expected_updated_at: AwareDatetime
    identity: InterestIdentity | None = None
    source_matches: dict[uuid.UUID, InterestSourceMatch] | None = Field(
        default=None, max_length=100
    )
    note: str | None = Field(default=None, max_length=5000)
    archived: bool | None = None

    @model_validator(mode="after")
    def reject_null_identity(self) -> InterestUpdate:
        for field in ("identity", "source_matches"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field}는 null일 수 없습니다")
        return self


class NewInterestProduct(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    volume_ml: int = Field(gt=0, le=100_000)
    name_en: str | None = Field(default=None, max_length=300)
    producer: str | None = Field(default=None, max_length=200)
    abv: Decimal | None = Field(default=None, ge=0, le=100)
    vintage: int | None = Field(default=None, ge=1800, le=2200)
    age_years: Decimal | None = Field(default=None, ge=0, le=100)
    category_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("제품 이름을 입력하세요")
        return value.strip()


class InterestPurchaseInput(BaseModel):
    expected_updated_at: AwareDatetime
    confirmed_identity: Literal[True]
    sku_id: uuid.UUID | None = None
    new_product: NewInterestProduct | None = None
    vendor_id: uuid.UUID | None = None
    purchased_on: datetime.date | None = None
    quantity: int = Field(default=1, gt=0, le=1000)
    unit_list_price: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    unit_paid_price: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)

    @model_validator(mode="after")
    def one_identity(self) -> InterestPurchaseInput:
        if (self.sku_id is None) == (self.new_product is None):
            raise ValueError("기존 규격 또는 새 제품 중 하나를 확정하세요")
        return self
