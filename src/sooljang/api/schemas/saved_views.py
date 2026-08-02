"""저장된 피벗 뷰 API 스키마(Task 20)."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class SavedViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    #: `api/schemas/stats.py::PivotRequest` 와 같은 모양을 기대하지만, 서버는 검증하지
    #: 않는다 — 불러와 다시 `POST /stats/pivot` 에 보낼 때 그 스키마가 검증한다.
    definition: dict[str, Any]


class SavedViewUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    definition: dict[str, Any] | None = None


class SavedViewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    definition: dict[str, Any]
    created_at: datetime
    updated_at: datetime
