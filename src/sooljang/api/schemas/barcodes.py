"""바코드 조회 API 스키마."""

import uuid
from typing import Literal

from pydantic import BaseModel

from sooljang.infrastructure.database.models import BarcodeType


class BarcodeLocalMatch(BaseModel):
    """이미 내 컬렉션에 등록된 규격과 일치했다."""

    product_id: uuid.UUID
    product_name: str
    sku_id: uuid.UUID
    volume_ml: int


class BarcodeExternalSuggestion(BaseModel):
    """Open Food Facts 가 제안한 정보. 사용자가 확인·수정한 뒤에만 저장해야 한다."""

    name: str
    brand: str | None
    quantity_text: str | None
    image_url: str | None
    source_url: str


class BarcodeLookupOut(BaseModel):
    barcode: str
    barcode_type: BarcodeType
    is_rcn: bool
    source: Literal["local", "external", "not_found"]
    local_match: BarcodeLocalMatch | None = None
    external_suggestion: BarcodeExternalSuggestion | None = None
