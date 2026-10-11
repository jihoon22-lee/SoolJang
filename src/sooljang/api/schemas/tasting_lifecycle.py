"""조회한 시음 버전만 삭제하거나 복구하는 멱등 요청."""

import datetime
import uuid

from pydantic import BaseModel, ConfigDict


class TastingLifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: uuid.UUID
    expected_updated_at: datetime.datetime


class TastingLifecycleResult(BaseModel):
    id: uuid.UUID
    updated_at: datetime.datetime
    deleted_at: datetime.datetime | None
