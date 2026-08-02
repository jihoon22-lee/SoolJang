"""첨부파일 API 스키마."""

import uuid

from pydantic import BaseModel, ConfigDict

from sooljang.infrastructure.database.models import AttachmentKind


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: AttachmentKind
    original_filename: str | None
    content_type: str
    byte_size: int
    caption: str | None
    product_id: uuid.UUID | None
    bottle_id: uuid.UUID | None
    tasting_session_id: uuid.UUID | None
