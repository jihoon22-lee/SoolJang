"""통계 대시보드 API 스키마.

`api/schemas/product.py` 의 `ProductMetricsOut` 과 같은 규칙을 따른다: 금액이 `null` 인
것은 0원이 아니라 가격 정보가 없다는 뜻이다.
"""

import uuid
from decimal import Decimal

from pydantic import BaseModel


class RankingEntryOut(BaseModel):
    product_id: uuid.UUID
    product_name: str
    value: Decimal


class RankingsOut(BaseModel):
    by_bottle_price: list[RankingEntryOut]
    by_total_spend: list[RankingEntryOut]
    by_price_per_100ml: list[RankingEntryOut]
    by_personal_rating: list[RankingEntryOut]


class CategoryStatOut(BaseModel):
    category_id: uuid.UUID | None
    name: str
    bottle_count: int
    total_spend: Decimal | None
    avg_abv: Decimal | None
    avg_rating: Decimal | None
    avg_price_per_100ml: Decimal | None
    discount_rate: Decimal | None


class StatsSummaryOut(BaseModel):
    purchased_count: int
    consumed_count: int
    in_stock_count: int
    unopened_count: int
    opened_count: int
    total_volume_ml: int
    list_total: Decimal | None
    paid_total: Decimal | None
    avg_list_price: Decimal | None
    avg_paid_price: Decimal | None
    avg_price_per_100ml: Decimal | None
    discount_rate: Decimal | None
    avg_personal_rating: Decimal | None
    vendor_count: int
