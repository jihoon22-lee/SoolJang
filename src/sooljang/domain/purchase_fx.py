"""외화 구매의 통화·환율·외화 단가·원화 실구매가 정합성(D276).

등록(`POST /purchases`)·수정(`PATCH /purchases/{id}`)·오프라인 동기화 생성/수정이 이 규칙
하나를 쓴다. 웹 수정 폼의 사전 검사(`web/src/domain/purchaseFx.ts`)도 같은 규칙이며 두
구현은 `tests/fixtures/purchase_fx_cases.json` 경계값으로 대조한다.

1. 외화 단가가 있으면 환율과 원화가 아닌 통화 코드가 함께 있어야 한다. 환율이 없으면 원화
   환산을 재현할 수 없다(DB CHECK `foreign_price_needs_fx_rate`보다 먼저 막는다).
2. 원화 실구매가는 외화 단가 × 환율과 1%(최소 1원) 안이어야 한다. 기록한 환율은 소수점을
   줄여 적는 일이 많아 작은 차이는 받지만, 외화 금액을 원화 칸에 넣은 것처럼 크게 다르면 어느
   쪽이 맞는지 알 수 없어 저장하지 않는다. 통계·평단가는 모두 원화 실구매가로 합산한다.
3. 원화 실구매가를 비우면 환산값을 저장한다. 비워 두면 외화 구매가 실구매가 미상이 된다.
"""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from decimal import Decimal, DecimalException
from typing import Any

from sooljang.domain.metrics import krw_from_foreign

#: 구매 금액 열(Numeric(14, 2))에 저장 자릿수로 반올림해도 담기는 상한(미만).
MAX_AMOUNT = Decimal("999999999999.995")
#: 환율 열(Numeric(14, 6))에 담기는 상한(미만).
MAX_FX_RATE = Decimal("99999999.9999995")
#: 외화 규칙에 걸리는 구매 필드. 수정은 이 중 하나라도 값이 바뀔 때만 검사한다.
FOREIGN_PRICE_FIELDS = ("currency", "fx_rate", "foreign_unit_price", "unit_paid_price")


class ForeignPriceError(ValueError):
    """외화 구매 값이 서로 맞지 않는다. `code`는 웹 사전 검사와 대조하는 이름이다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ForeignPrice:
    """구매 한 건의 외화 관련 값."""

    currency: str
    fx_rate: Decimal | None
    foreign_unit_price: Decimal | None
    unit_paid_price: Decimal | None

    @classmethod
    def of(cls, row: Any) -> ForeignPrice:
        """`FOREIGN_PRICE_FIELDS` 속성을 가진 구매 행에서 읽는다."""
        return cls(**{key: getattr(row, key) for key in FOREIGN_PRICE_FIELDS})


def reconcile_foreign_price(
    *,
    currency: str,
    fx_rate: Decimal | None,
    foreign_unit_price: Decimal | None,
    unit_paid_price: Decimal | None,
) -> Decimal | None:
    """외화 규칙을 검사하고 저장할 원화 실구매가를 돌려준다. 외화 단가가 없으면 그대로다."""
    if foreign_unit_price is None:
        return unit_paid_price
    if fx_rate is None:
        raise ForeignPriceError("fx_rate_required", "외화 단가를 넣으려면 환율이 필요합니다")
    if currency.upper() == "KRW":
        raise ForeignPriceError(
            "currency_not_foreign", "외화 단가에는 원화가 아닌 통화 코드가 필요합니다"
        )
    try:
        converted = foreign_unit_price * fx_rate
    except DecimalException as error:
        raise ForeignPriceError("too_large", "외화 단가 × 환율을 계산할 수 없습니다") from error
    if converted >= MAX_AMOUNT:
        raise ForeignPriceError("too_large", "외화 단가 × 환율이 저장할 수 있는 금액보다 큽니다")
    if unit_paid_price is None:
        return krw_from_foreign(foreign_unit_price, fx_rate)
    if abs(unit_paid_price - converted) > max(Decimal(1), converted / 100):
        raise ForeignPriceError(
            "paid_mismatch", "병당 실구매가가 외화 단가 × 환율과 1% 넘게 다릅니다"
        )
    return unit_paid_price


def reconcile_update(stored: ForeignPrice, updates: Mapping[str, Any]) -> dict[str, Any]:
    """구매 수정 값을 저장된 값에 합쳐 외화 규칙을 검사하고 저장할 수정 값을 돌려준다.

    네 값 중 실제로 바뀌는 것이 없으면 검사하지 않는다. 이미 어긋난 이전 기록(레거시·검사 전
    수정)도 같은 값을 다시 보내는 수정으로 구매처·정가는 고칠 수 있다. 실구매가를 비우면
    환산값을 채운다.
    """
    result = dict(updates)
    merged = replace(
        stored, **{key: updates[key] for key in FOREIGN_PRICE_FIELDS if key in updates}
    )
    if merged == stored:
        return result
    paid = reconcile_foreign_price(
        currency=merged.currency,
        fx_rate=merged.fx_rate,
        foreign_unit_price=merged.foreign_unit_price,
        unit_paid_price=merged.unit_paid_price,
    )
    if paid != merged.unit_paid_price:
        result["unit_paid_price"] = paid
    return result
