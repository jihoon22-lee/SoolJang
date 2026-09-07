"""공유 관심의 구매 전환. B08 전환 영수증 테이블을 사용한다."""

import uuid

from fastapi import APIRouter

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.schemas.interests import InterestPurchaseInput
from sooljang.application.interest_conversion import convert_interest

router = APIRouter(prefix="/interests", tags=["interests"])


@router.post("/{interest_id}/purchase", status_code=201)
async def purchase_interest(
    interest_id: uuid.UUID, payload: InterestPurchaseInput, session: SessionDep, user_id: UserDep
) -> dict[str, str]:
    fields = payload.model_dump(
        exclude={"sku_id", "new_product", "confirmed_identity", "expected_updated_at"}
    )
    return await convert_interest(
        session,
        user_id,
        interest_id,
        sku_id=payload.sku_id,
        expected_updated_at=payload.expected_updated_at,
        product_fields=payload.new_product.model_dump() if payload.new_product else None,
        purchase_fields=fields,
    )
