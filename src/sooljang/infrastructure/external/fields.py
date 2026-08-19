"""표준 필드 스키마: 소스마다 제각각인 `fields` 를 비교 가능한 형태로 통일한다(Task 34 PR3).

소스가 하나뿐일 때는 `fields` 자유 dict 로도 충분했다 — 카드 하나에 값을 나열하면 됐다.
소스가 여럿이 되면 `가격`·`price`·`sale_price` 처럼 소스마다 다른 키로 같은 개념을
가리켜 비교·최저가 계산이 불가능해진다(계획서 진단 8번). 이 모듈은 `adapter_spec.detail
.fields`/`search.result_fields` 가 아래 표준 키로 값을 내보냈을 때 그것을 추려 타입까지
맞추고, 표준 키가 아닌 값은 `extra` 에 그대로 보존한다 — 손실 없이 기존 자유 dict 동작과
호환된다(소스가 아직 표준 키를 안 쓰면 비교 뷰에만 안 잡힐 뿐, 값 자체는 그대로 보인다).

**파생값(정규화 평점·100ml당 가격)은 저장하지 않는다**(절대 규칙 6). `domain/metrics.py`
가 구매 기록에 대해 지키는 것과 같은 원칙을 외부 조회 결과에도 적용한다 — 이 모듈의
프로퍼티는 응답을 조립할 때마다 다시 계산되고, DB 에는 원본 `fields` 만 저장된다.

이 모듈은 순수 함수다. `application/external_sources.py` 가 캐시 적중·신규 조회 양쪽
경로에서 공통으로 호출해, 어느 경로든 같은 규칙으로 분류·계산된다.
"""

import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

#: 표준 필드 키. adapter_spec 작성자가 이 이름으로 값을 내보내면 비교 뷰에 잡힌다.
STANDARD_KEYS = frozenset(
    {
        "price_krw",
        "list_price_krw",
        "currency",
        "volume_ml",
        "rating",
        "rating_scale",
        "review_count",
        "in_stock",
    }
)

#: 100ml 환산 계수. `domain/metrics.py::ML_PER_UNIT` 과 같은 값이지만, 이 모듈은 domain
#: 계층을 import 하지 않는다 — 외부 조회는 순수 dict 변환일 뿐 구매 도메인이 아니다.
_ML_PER_UNIT = Decimal(100)
_MONEY_QUANT = Decimal("0.01")
_RATING_TARGET_SCALE = Decimal(5)
_TRUE_TOKENS = frozenset({"true", "1", "yes", "y", "있음", "재고있음", "구매가능"})
_FALSE_TOKENS = frozenset({"false", "0", "no", "n", "없음", "품절", "재고없음"})


@dataclass(frozen=True, slots=True)
class NormalizedFields:
    """`fields` dict 하나를 표준 키로 분류하고 파생값을 계산한 결과."""

    price_krw: int | None = None
    list_price_krw: int | None = None
    currency: str = "KRW"
    volume_ml: int | None = None
    rating: float | None = None
    rating_scale: float | None = None
    review_count: int | None = None
    in_stock: bool | None = None
    #: 표준 키가 아닌 값. 기존 소스가 표준 키로 안 바뀌어도 값이 사라지지 않는다.
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def rating_normalized(self) -> Decimal | None:
        """평점을 5점 만점으로 환산한다. 척도를 모르면 계산하지 않는다."""
        if self.rating is None or self.rating_scale is None or self.rating_scale <= 0:
            return None
        value = Decimal(str(self.rating)) * _RATING_TARGET_SCALE / Decimal(str(self.rating_scale))
        return value.quantize(_MONEY_QUANT, rounding=ROUND_HALF_UP)

    @property
    def price_per_100ml(self) -> Decimal | None:
        """100ml당 가격. 용량을 모르면(0 나눗셈 방지) 계산하지 않는다."""
        if self.price_krw is None or self.volume_ml is None or self.volume_ml <= 0:
            return None
        value = Decimal(self.price_krw) * _ML_PER_UNIT / Decimal(self.volume_ml)
        return value.quantize(_MONEY_QUANT, rounding=ROUND_HALF_UP)


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None  # bool 은 int 의 서브클래스라 여기서 걸러야 in_stock 오분류를 막는다
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[^\d.\-]", "", value)
        if not cleaned:
            return None
        try:
            return round(float(cleaned))
        except ValueError:
            return None
    return None


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[^\d.\-]", "", value)
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _TRUE_TOKENS:
            return True
        if lowered in _FALSE_TOKENS:
            return False
    return None


#: 키 이름 → (변환 함수, 실패 시 extra 에 남길지). 전부 실패하면 extra 로 돌린다 —
#: 잘못된 타입을 표준 필드에 흘려보내면 파생값 계산이 조용히 깨진다.
_COERCERS: dict[str, Any] = {
    "price_krw": _coerce_int,
    "list_price_krw": _coerce_int,
    "volume_ml": _coerce_int,
    "review_count": _coerce_int,
    "rating": _coerce_float,
    "rating_scale": _coerce_float,
    "in_stock": _coerce_bool,
}


def split_fields(raw: dict[str, Any]) -> NormalizedFields:
    """추출된 `fields` dict 를 표준 필드와 `extra` 로 나눈다."""
    values: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    currency = "KRW"

    for key, value in raw.items():
        if value is None:
            continue
        if key == "currency":
            if isinstance(value, str):
                currency = value
            else:
                extra[key] = value
            continue
        coercer = _COERCERS.get(key)
        if coercer is None:
            extra[key] = value
            continue
        coerced = coercer(value)
        if coerced is None:
            extra[key] = value
        else:
            values[key] = coerced

    return NormalizedFields(
        price_krw=values.get("price_krw"),
        list_price_krw=values.get("list_price_krw"),
        currency=currency,
        volume_ml=values.get("volume_ml"),
        rating=values.get("rating"),
        rating_scale=values.get("rating_scale"),
        review_count=values.get("review_count"),
        in_stock=values.get("in_stock"),
        extra=extra,
    )
