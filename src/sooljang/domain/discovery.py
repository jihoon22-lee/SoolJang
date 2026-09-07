"""외부 탐색에서 공유하는 상태·판본·판매 조건의 최소 계약.

연결·원문·제품·판매 조건·가격 관측의 identity를 구분한다. HTTP나 DB에 의존하지 않는다.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum


class SourceOutcome(StrEnum):
    UNKNOWN = "unknown"
    SUCCESS = "success"
    EMPTY = "empty"
    PARTIAL = "partial"
    AUTHENTICATION_FAILED = "authentication_failed"
    FORBIDDEN = "forbidden"
    RATE_LIMITED = "rate_limited"
    NETWORK_ERROR = "network_error"
    PARSE_ERROR = "parse_error"
    POLICY_BLOCKED = "policy_blocked"
    INVALID_CONFIGURATION = "invalid_configuration"
    CREDENTIAL_UNAVAILABLE = "credential_unavailable"


class RequestBudgetExceeded(Exception):
    """외부 요청 예약 한도 초과. 비밀값이나 질의를 오류에 포함하지 않는다."""


@dataclass(frozen=True, slots=True)
class OfferIdentity:
    """같은 상품의 다른 판매처·규격·조건을 가격 비교에서 합치지 않는다."""

    source_key: str
    product_key: str
    seller_key: str
    variant_key: str
    volume_ml: Decimal | None
    units: int = 1
    condition_key: str = "standard"

    def __post_init__(self) -> None:
        if not all((self.source_key, self.product_key, self.seller_key, self.variant_key)):
            raise ValueError("출처·제품·판매처·판본 식별자가 필요합니다")
        if self.units < 1:
            raise ValueError("판매 단위 수는 1 이상이어야 합니다")
        if self.volume_ml is not None and (not self.volume_ml.is_finite() or self.volume_ml <= 0):
            raise ValueError("규격 용량은 유한한 양수여야 합니다")

    def comparable_to(self, other: OfferIdentity) -> bool:
        """상위 매칭에서 정규화한 판본과 알려진 규격·조건이 같은 경우만 비교한다."""
        return (
            self.variant_key == other.variant_key
            and self.volume_ml is not None
            and self.volume_ml == other.volume_ml
            and self.units == other.units
            and self.condition_key == other.condition_key
        )


@dataclass(frozen=True, slots=True)
class PriceObservation:
    """조회/캐시 사용 시각이 아니라 출처에서 실제 관측한 시각을 보존하는 1차 사실."""

    offer: OfferIdentity
    amount: Decimal | None
    currency: str
    source_url: str
    observed_at: datetime
    complete: bool = False

    def __post_init__(self) -> None:
        if self.amount is not None and (not self.amount.is_finite() or self.amount < 0):
            raise ValueError("관측 가격은 유한한 0 이상의 값이어야 합니다")
        if len(self.currency) != 3 or not self.currency.isascii() or not self.currency.isupper():
            raise ValueError("통화는 3자리 대문자 코드를 사용합니다")
        if not self.currency.isalpha():
            raise ValueError("통화는 영문 코드여야 합니다")
        if not self.source_url.startswith(("https://", "http://")):
            raise ValueError("출처 URL이 필요합니다")
        if self.observed_at.tzinfo is None or self.observed_at.utcoffset() is None:
            raise ValueError("관측 시각에는 시간대가 필요합니다")
