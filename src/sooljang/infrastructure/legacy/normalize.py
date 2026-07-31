"""레거시 시트 필드 정규화.

사양은 `docs/legacy-schema.md` §4 에 있다. 모든 함수는 순수 함수이며 I/O 를 하지 않는다.
파싱 실패는 예외 대신 `None` 또는 빈 값으로 표현하고, 어떤 행이 왜 비었는지는 상위
계층(`records.py`)이 경고로 모은다. 한 행의 이상값이 전체 임포트를 중단시켜서는 안 된다.
"""

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

# CP949 에서 원화 기호(₩)가 백슬래시(0x5C)와 같은 코드포인트다. 금액 문자열은
# `" \23,980 "` 형태로 저장되어 있다.
_WON_SIGNS = "\\₩"
_MONEY_STRIP = re.compile(rf"[{re.escape(_WON_SIGNS)},\s]")

# 가격 없음(선물 등)을 뜻하는 표기. 엑셀 수식 오류도 값 없음으로 취급한다.
_EMPTY_TOKENS = frozenset({"", "-", "–", "—", "#N/A", "#VALUE!", "#DIV/0!", "#REF!", "N/A"})

_VOLUME_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*(ml|mL|ML|l|L|리터)?")
_ABV_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*%?")
_TRAILING_VINTAGE = re.compile(r",\s*((?:19|20)\d{2})\s*$")

# 외부 평점의 소스 태그. 예: `3.40 (RB)`, `4.06/91 (BA)`
_RATING_WITH_TAG = re.compile(
    r"^(?P<value>\d+(?:\.\d+)?)(?:/(?P<secondary>\d+(?:\.\d+)?))?\s*(?:\((?P<tag>[A-Za-z]+)\))?$"
)

# 비고 안의 외화 표기. 예: `$46.67 (환율 1431.6원)`, `$127(환율 1443원)`
_FOREIGN_PRICE = re.compile(
    r"(?P<symbol>[$€¥£])\s*(?P<amount>[\d,]+(?:\.\d+)?)"
    r"(?:\s*\(\s*환율\s*(?P<rate>[\d,]+(?:\.\d+)?)\s*원?\s*\))?"
)

_CURRENCY_BY_SYMBOL = {"$": "USD", "€": "EUR", "¥": "JPY", "£": "GBP"}


def is_empty_token(value: str | None) -> bool:
    """값 없음으로 취급할 문자열인지 판정한다."""
    return value is None or value.strip() in _EMPTY_TOKENS


def parse_money(value: str | None) -> Decimal | None:
    """`" \\23,980 "` 같은 금액 문자열을 Decimal 로 바꾼다.

    원화 기호·쉼표·공백을 제거한다. 값 없음 표기는 None 을 반환한다.
    """
    if value is None:
        return None
    stripped = value.strip()
    if is_empty_token(stripped):
        return None
    cleaned = _MONEY_STRIP.sub("", stripped)
    if not cleaned or cleaned in {"-", "+"}:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def parse_volume_ml(value: str | None) -> int | None:
    """`750ml`, `1L` 같은 용량 표기를 ml 정수로 바꾼다."""
    if is_empty_token(value):
        return None
    assert value is not None
    match = _VOLUME_PATTERN.search(value.replace(",", ""))
    if match is None:
        return None
    amount = Decimal(match.group(1))
    unit = (match.group(2) or "ml").lower()
    if unit in {"l", "리터"}:
        amount *= 1000
    result = int(amount)
    return result if result > 0 else None


def parse_abv(value: str | None) -> Decimal | None:
    """`14.5%` 같은 도수 표기를 소수로 바꾼다. 범위를 벗어나면 None."""
    if is_empty_token(value):
        return None
    assert value is not None
    match = _ABV_PATTERN.search(value.replace(",", ""))
    if match is None:
        return None
    abv = Decimal(match.group(1))
    return abv if Decimal(0) <= abv <= Decimal(100) else None


def parse_int(value: str | None) -> int | None:
    """병수 같은 정수 필드를 파싱한다."""
    if is_empty_token(value):
        return None
    assert value is not None
    cleaned = value.strip().replace(",", "")
    return int(cleaned) if re.fullmatch(r"-?\d+", cleaned) else None


def parse_rating(value: str | None, *, maximum: Decimal = Decimal(6)) -> Decimal | None:
    """개인 평점을 파싱한다. 레거시는 0.5 단위 6점 만점이다."""
    if is_empty_token(value):
        return None
    assert value is not None
    match = re.search(r"\d+(?:\.\d+)?", value.replace(",", ""))
    if match is None:
        return None
    rating = Decimal(match.group())
    return rating if Decimal(0) < rating <= maximum else None


def split_multivalue(value: str | None) -> list[str]:
    """셀 내 개행으로 구분된 다중값을 분해한다.

    레거시는 품종·외부 평점·구매처를 한 셀에 개행으로 몰아넣었다
    (`docs/legacy-schema.md` §4.5).
    """
    if value is None:
        return []
    return [part.strip() for part in value.splitlines() if part.strip()]


def split_name_and_note(value: str) -> tuple[str, str | None]:
    """이름 셀의 첫 줄을 이름으로, 나머지를 부가 설명으로 나눈다.

    레거시 32행이 발효일 같은 설명을 2번째 줄에 붙여 두었다.
    """
    lines = split_multivalue(value)
    if not lines:
        return "", None
    return lines[0], "\n".join(lines[1:]) or None


def extract_vintage(name: str) -> tuple[str, int | None]:
    """이름 뒤에 붙은 `, 2019` 패턴을 빈티지로 분리한다.

    레거시 99행이 이 형태다. 이름에서 제거한 나머지를 함께 반환한다.
    """
    match = _TRAILING_VINTAGE.search(name)
    if match is None:
        return name.strip(), None
    return name[: match.start()].strip().rstrip(","), int(match.group(1))


@dataclass(frozen=True, slots=True)
class ExternalRatingValue:
    """소스 태그가 붙은 외부 평점 한 건."""

    value: Decimal
    source_code: str | None
    secondary_value: Decimal | None = None
    raw: str = ""


def parse_external_ratings(value: str | None) -> list[ExternalRatingValue]:
    """`3.40 (RB)` / `4.06/91 (BA)` / `3.9` 형태를 소스별로 분해한다.

    태그 어휘는 RB=RateBeer, U=Untappd, BA=BeerAdvocate 이며 태그 없는 값도 있다
    (`docs/legacy-schema.md` §4.7). 소스마다 스케일이 다르므로 값과 태그를 분리해
    보관하고, 스케일 해석은 소스 레지스트리가 담당한다.
    """
    ratings: list[ExternalRatingValue] = []
    for part in split_multivalue(value):
        if is_empty_token(part):
            continue
        match = _RATING_WITH_TAG.match(part)
        if match is None:
            continue
        secondary = match.group("secondary")
        ratings.append(
            ExternalRatingValue(
                value=Decimal(match.group("value")),
                source_code=match.group("tag"),
                secondary_value=Decimal(secondary) if secondary else None,
                raw=part,
            )
        )
    return ratings


@dataclass(frozen=True, slots=True)
class ForeignPrice:
    """비고에서 추출한 외화 구매 정보."""

    currency: str
    amount: Decimal
    fx_rate: Decimal | None
    raw: str


def parse_foreign_price(note: str | None) -> ForeignPrice | None:
    """비고의 `$46.67 (환율 1431.6원)` 형태를 파싱한다.

    레거시 15행이 면세점·해외 구매를 이 형태로 기록했다. 환율은 구매 시점 값이므로
    그대로 보관한다. 현재 환율로 재평가하면 과거 지출액이 매일 바뀌어 통계가 재현되지 않는다.
    """
    if note is None:
        return None
    match = _FOREIGN_PRICE.search(note)
    if match is None:
        return None
    currency = _CURRENCY_BY_SYMBOL.get(match.group("symbol"))
    if currency is None:
        return None
    rate = match.group("rate")
    return ForeignPrice(
        currency=currency,
        amount=Decimal(match.group("amount").replace(",", "")),
        fx_rate=Decimal(rate.replace(",", "")) if rate else None,
        raw=match.group(0),
    )


def normalize_name_for_matching(name: str) -> str:
    """제품 중복 판정용 정규화 키.

    공백·구두점·대소문자 차이를 제거한다. 임포트가 같은 술을 여러 제품으로 쪼개지
    않게 하는 것이 목적이다. 구두점을 지운 뒤 공백을 다시 축약해야 `A - B` 가
    `A  B`(공백 2개)로 남지 않는다.
    """
    lowered = name.strip().lower()
    without_punctuation = re.sub(r"[^0-9a-z가-힣\s\u3000]+", " ", lowered)
    return re.sub(r"[\s\u3000]+", " ", without_punctuation).strip()
