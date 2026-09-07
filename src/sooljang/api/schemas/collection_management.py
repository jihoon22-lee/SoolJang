"""보관·실사와 제한된 일괄 정리 입력."""

import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class LocationInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["cabinet", "shelf", "box"] = "shelf"
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("이름을 입력하세요")
        return value.strip()


class PlacementInput(BaseModel):
    location_id: uuid.UUID | None


class StocktakeInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    location_id: uuid.UUID | None = None


class StocktakeStatusInput(BaseModel):
    status: Literal["active", "paused", "completed"]


class ScanInput(BaseModel):
    bottle_code: str = Field(min_length=1, max_length=100)
    observed_location_id: uuid.UUID | None = None


class FoundInput(BaseModel):
    note: str = Field(min_length=1, max_length=1000)


class CleanupInput(BaseModel):
    kind: Literal["vendor_merge", "product_category", "purchase_vendor", "location_delete"]
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    target_id: uuid.UUID | None = None
