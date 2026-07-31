"""병 상태 전이와 시음 세션 API 스키마."""

import datetime
import uuid
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from sooljang.infrastructure.database.models import BottleStatus


class BottleOut(BaseModel):
    """개별 병."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    purchase_id: uuid.UUID
    label_no: int
    status: BottleStatus
    opened_on: datetime.date | None = None
    finished_on: datetime.date | None = None
    #: `null` 이면 미개봉(규격 용량 전량)이라는 뜻이다. 0ml 이 아니다.
    remaining_ml: int | None = None
    storage_location: str | None = None
    note: str | None = None


class OpenBottleRequest(BaseModel):
    """개봉."""

    opened_on: datetime.date | None = Field(default=None, description="비우면 오늘")
    remaining_ml: int | None = Field(
        default=None, ge=0, description="비우면 규격 용량 전량으로 초기화"
    )


class FinishBottleRequest(BaseModel):
    """소진."""

    finished_on: datetime.date | None = Field(default=None, description="비우면 오늘")


class HandOverRequest(BaseModel):
    """증여·판매. 잔량을 0 으로 만들지 않는다."""

    on: datetime.date | None = Field(default=None, description="비우면 오늘")
    note: str | None = None


class TastingCreate(BaseModel):
    """시음 기록."""

    tasted_on: datetime.date
    #: 병에서 마신 경우에만 잔량을 차감한다.
    bottle_id: uuid.UUID | None = None
    sku_id: uuid.UUID | None = Field(default=None, description="병을 지정하면 생략할 수 있다")
    poured_ml: int | None = Field(default=None, gt=0)
    #: 6점 만점 0.5 단위. 레거시 시트와 같은 척도다.
    rating: Decimal | None = Field(default=None, ge=0, le=6)
    nose: str | None = None
    palate: str | None = None
    finish: str | None = None
    note: str | None = None
    place: str | None = None
    companions: str | None = None


class TastingOut(BaseModel):
    """시음 기록 응답."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    bottle_id: uuid.UUID | None = None
    sku_id: uuid.UUID
    tasted_on: datetime.date
    poured_ml: int | None = None
    rating: Decimal | None = None
    nose: str | None = None
    palate: str | None = None
    finish: str | None = None
    note: str | None = None
    place: str | None = None
    companions: str | None = None


class TastingSummaryOut(BaseModel):
    """시음 요약.

    평점이 없는 세션은 평균에서 제외한다. 0 으로 세면 평점을 적지 않은 기록이 평균을 끌어내린다.
    """

    session_count: int
    rated_count: int
    average_rating: Decimal | None = None
    first_rating: Decimal | None = None
    latest_rating: Decimal | None = None
    #: 첫 평점 대비 최근 평점의 변화. 양수면 처음보다 좋아졌다는 뜻이다.
    rating_change: Decimal | None = None
    total_poured_ml: int
    first_tasted_on: datetime.date | None = None
    latest_tasted_on: datetime.date | None = None
