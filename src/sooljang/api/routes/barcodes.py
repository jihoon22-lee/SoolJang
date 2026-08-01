"""바코드 조회 라우터. `docs/architecture.md` §4.2 `GET /barcodes/{code}`."""

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import ValidationFailedError
from sooljang.api.schemas.barcodes import (
    BarcodeExternalSuggestion,
    BarcodeLocalMatch,
    BarcodeLookupOut,
)
from sooljang.application.barcodes import InvalidBarcodeError, normalize_and_classify
from sooljang.infrastructure.database.models import BarcodeType, Sku
from sooljang.infrastructure.external import open_food_facts

router = APIRouter(prefix="/barcodes", tags=["barcodes"])


@router.get("/{code}", response_model=BarcodeLookupOut, summary="바코드 조회 (로컬 → 외부)")
async def lookup_barcode(code: str, session: SessionDep, user_id: UserDep) -> BarcodeLookupOut:
    """스캔한 바코드를 내 컬렉션에서 먼저 찾고, 없으면 Open Food Facts 를 조회한다.

    어느 쪽도 못 찾으면 `source: "not_found"` 로 응답한다 — 사용자가 직접 검색하거나
    새로 등록하는 경로로 넘어가라는 신호다. 이 엔드포인트는 조회만 한다. 매칭을
    "학습"(바코드를 규격에 저장)하려면 사용자가 확인한 뒤 `POST /products` 또는
    `PATCH /skus/{id}` 를 별도로 호출해야 한다 — 스캔 한 번으로 조용히 데이터를
    바꾸지 않는다.
    """
    try:
        normalized, barcode_type = normalize_and_classify(code)
    except InvalidBarcodeError as error:
        raise ValidationFailedError(str(error)) from error

    is_rcn = barcode_type == BarcodeType.RCN

    sku = await session.scalar(
        select(Sku)
        .where(Sku.user_id == user_id, Sku.barcode == normalized, Sku.deleted_at.is_(None))
        .options(selectinload(Sku.product))
    )
    if sku is not None:
        return BarcodeLookupOut(
            barcode=normalized,
            barcode_type=barcode_type,
            is_rcn=is_rcn,
            source="local",
            local_match=BarcodeLocalMatch(
                product_id=sku.product_id,
                product_name=sku.product.name,
                sku_id=sku.id,
                volume_ml=sku.volume_ml,
            ),
        )

    # RCN 은 매장 내부용이라 전역 조회가 애초에 의미가 없다 — 외부 호출을 건너뛴다.
    external = None if is_rcn else await open_food_facts.lookup(normalized)
    if external is not None:
        return BarcodeLookupOut(
            barcode=normalized,
            barcode_type=barcode_type,
            is_rcn=is_rcn,
            source="external",
            external_suggestion=BarcodeExternalSuggestion(
                name=external.name,
                brand=external.brand,
                quantity_text=external.quantity_text,
                image_url=external.image_url,
                source_url=external.source_url,
            ),
        )

    return BarcodeLookupOut(
        barcode=normalized, barcode_type=barcode_type, is_rcn=is_rcn, source="not_found"
    )
