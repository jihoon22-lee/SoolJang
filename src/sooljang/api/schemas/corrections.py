"""원본 연결을 보존하는 온라인 정정 계약."""

import datetime
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from sooljang.api.schemas.product import PurchaseOut
from sooljang.api.schemas.tasting import BottleOut, TastingCreate, TastingOut


class ProductSkuContext(BaseModel):
    product_id: uuid.UUID
    product_name: str
    vintage: int | None
    age_years: str | None
    abv: str | None
    sku_id: uuid.UUID
    volume_ml: int


class PurchaseContext(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    updated_at: datetime.datetime
    sku_id: uuid.UUID
    purchased_on: datetime.date | None
    vendor_id: uuid.UUID | None
    vendor_name: str | None
    quantity: int


class BottleSnapshot(BottleOut):
    deleted_at: datetime.datetime | None


class ContextualTasting(TastingOut):
    updated_at: datetime.datetime
    context: ProductSkuContext
    purchase: PurchaseContext | None
    bottle: BottleSnapshot | None


class DeletedTasting(ContextualTasting):
    """최근 삭제한 시음. 복구 요청의 `expected_updated_at`으로 `updated_at`을 쓴다."""

    deleted_at: datetime.datetime


class ContextualTastingPage(BaseModel):
    items: list[ContextualTasting]
    next_cursor: str | None = None


class DeletedTastingPage(BaseModel):
    """최근 삭제한 시음 한 쪽. `next_cursor` 로 30일 안의 나머지 기록을 이어 읽는다."""

    items: list[DeletedTasting]
    next_cursor: str | None = None


class BottleCorrectionContext(BaseModel):
    context: ProductSkuContext
    purchase: PurchaseContext
    bottle: BottleSnapshot


class PurchaseWithVersion(PurchaseOut):
    updated_at: datetime.datetime


class LinkedTasting(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    bottle_id: uuid.UUID
    sku_id: uuid.UUID
    updated_at: datetime.datetime
    deleted_at: datetime.datetime | None


class PurchaseCorrectionContext(BaseModel):
    purchase: PurchaseWithVersion
    context: ProductSkuContext
    bottles: list[BottleSnapshot]
    tastings: list[LinkedTasting]


class BottleGuard(BaseModel):
    id: uuid.UUID
    revision: uuid.UUID


class TastingGuard(BaseModel):
    id: uuid.UUID
    updated_at: datetime.datetime


class FinalBottleState(BaseModel):
    id: uuid.UUID
    status: Literal["unopened", "open", "finished", "gifted", "sold"]
    remaining_ml: int | None = Field(ge=0, le=100_000)
    opened_on: datetime.date | None
    finished_on: datetime.date | None


class TastingChanges(TastingCreate):
    model_config = ConfigDict(extra="forbid")
    tasted_on: datetime.date | None = None
    poured_ml: int | None = Field(default=None, gt=0, le=2**31 - 1)
    place: str | None = Field(default=None, max_length=200)


class TastingCorrection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: uuid.UUID
    expected_updated_at: datetime.datetime
    changes: TastingChanges
    expected_bottles: list[BottleGuard]
    remaining_mode: Literal["preserve", "set_final"]
    final_bottles: list[FinalBottleState]
    target_sku_expected_volume_ml: int | None = Field(default=None, gt=0, le=100_000)


class PurchaseSkuCorrection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: uuid.UUID
    expected_updated_at: datetime.datetime
    target_sku_id: uuid.UUID
    target_sku_expected_volume_ml: int = Field(gt=0, le=100_000)
    expected_bottles: list[BottleGuard]
    expected_tastings: list[TastingGuard]
    final_bottles: list[FinalBottleState]
