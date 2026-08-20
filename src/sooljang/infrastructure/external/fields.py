"""외부 조회 결과의 표준 필드 스키마(Task 34 PR3).

## 왜 필요한가

Task 18 은 `adapter_spec` 이 뽑은 값을 자유 dict 로 그대로 저장했다. 그래서 소스마다
필드명이 제각각이다 — 실제로 등록된 데일리샷 스펙은 `가격`·`평점`·`리뷰수` 라는 한글
키를 쓴다. 소스가 하나일 때는 문제가 없지만, 여럿이 되면 **서로 다른 이름의 값을 나열하는
카드가 늘어날 뿐 비교가 불가능하다**(현황 진단 8번).

여기서 표준 키를 정하고, `adapter_spec` 이 그 키로 값을 내보내게 한다. 표준 키가 아닌
값은 버리지 않고 `extra` 에 그대로 담는다 — **기존 소스가 깨지지 않는 것이 중요하다.**
비교 표에 안 잡힐 뿐 값은 그대로 보인다.

## 파생값을 여기서 계산하지 않는 이유

100ml당 가격과 평점 환산은 **저장하지 않는다**(§8 절대 규칙 6 — 파생값을 DB 에 저장하지
않는다). API 응답을 조립할 때 계산한다. 이 모듈은 "무엇이 표준 키인가" 와 "원시 값을 그
타입으로 어떻게 바꾸는가" 만 안다.
"""

import re
from typing import Any

#: 스냅샷 구조 버전. 올리면 낮은 버전의 캐시 행은 TTL 과 무관하게 stale 로 취급된다 —
#: 캐시는 정의상 언제든 버려도 되는 데이터라 마이그레이션 스크립트를 쓸 이유가 없다.
SNAPSHOT_VERSION = 2

#: 표준 키와 그 타입. `adapter_spec` 의 `detail.fields`/`search.result_fields` 가 이
#: 이름으로 값을 내보내면 비교 가능한 형태가 된다.
PRICE_KRW = "price_krw"
LIST_PRICE_KRW = "list_price_krw"
CURRENCY = "currency"
VOLUME_ML = "volume_ml"
RATING = "rating"
RATING_SCALE = "rating_scale"
REVIEW_COUNT = "review_count"
IN_STOCK = "in_stock"

_INT_KEYS = frozenset({PRICE_KRW, LIST_PRICE_KRW, VOLUME_ML, REVIEW_COUNT})
_FLOAT_KEYS = frozenset({RATING, RATING_SCALE})
_BOOL_KEYS = frozenset({IN_STOCK})
_STR_KEYS = frozenset({CURRENCY})

STANDARD_KEYS = _INT_KEYS | _FLOAT_KEYS | _BOOL_KEYS | _STR_KEYS

DEFAULT_CURRENCY = "KRW"

#: 숫자만 남긴다. `"89,000원"` `"₩89000"` `"89 000"` 모두 89000 이 되게 한다.
_NON_NUMERIC = re.compile(r"[^\d.\-]")
_TRUTHY = frozenset({"true", "1", "y", "yes", "재고있음", "구매가능", "in_stock", "instock"})
_FALSY = frozenset({"false", "0", "n", "no", "품절", "재고없음", "out_of_stock", "soldout"})


def _to_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if not isinstance(value, str):
        return None
    cleaned = _NON_NUMERIC.sub("", value)
    if not cleaned or cleaned in ("-", ".", "-."):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _TRUTHY:
            return True
        if lowered in _FALSY:
            return False
    return None


def coerce(key: str, value: Any) -> Any:
    """표준 키 하나의 값을 그 키의 타입으로 바꾼다. 못 바꾸면 `None`.

    사이트는 가격을 `"89,000원"` 처럼 문자열로 준다 — 숫자로 바꿔 두지 않으면 최저가
    비교가 문자열 비교가 돼 버린다.
    """
    if value is None:
        return None
    if key in _INT_KEYS:
        number = _to_number(value)
        return None if number is None else int(round(number))
    if key in _FLOAT_KEYS:
        return _to_number(value)
    if key in _BOOL_KEYS:
        return _to_bool(value)
    if key in _STR_KEYS:
        return str(value).strip() or None
    return value


def split_fields(raw: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """추출된 값을 표준 필드와 `extra` 로 가른다.

    표준 키가 아닌 값은 **버리지 않는다** — 데일리샷의 `가격`·`평점` 처럼 기존 소스가
    쓰는 이름이 여기로 들어와, 비교 표에 안 잡힐 뿐 화면에는 그대로 보인다.
    """
    standard: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for key, value in raw.items():
        if key in STANDARD_KEYS:
            standard[key] = coerce(key, value)
        else:
            extra[key] = value
    return standard, extra


def rating_normalized(rating: Any, scale: Any) -> float | None:
    """평점을 0~5 척도로 환산한다. 소스마다 척도가 달라(5점·100점) 그대로는 못 비교한다."""
    value = _to_number(rating)
    scale_value = _to_number(scale)
    if value is None or scale_value is None or scale_value <= 0:
        return None
    return round(value / scale_value * 5, 2)


def price_per_100ml(price: Any, volume_ml: Any) -> float | None:
    """100ml당 가격. 용량을 모르면 계산하지 않는다(0 나눗셈 방지).

    이 앱은 이미 `price_per_100ml` 파생 지표를 쓰고 있어, 내 실평단가와 같은 단위로
    나란히 놓고 볼 수 있다 — 그게 이 기능의 실질 가치다.
    """
    price_value = _to_number(price)
    volume_value = _to_number(volume_ml)
    if price_value is None or volume_value is None or volume_value <= 0:
        return None
    return round(price_value / volume_value * 100, 2)
