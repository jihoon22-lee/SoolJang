"""제품·규격·구매·구매처 API 스키마."""

import datetime
import uuid
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sooljang.infrastructure.database.models import BarcodeType, BottleStatus, VendorKind

# --- 규격 -------------------------------------------------------------------


class SkuCreate(BaseModel):
    volume_ml: int = Field(gt=0, le=100_000, description="병당 용량(ml)")
    barcode: str | None = Field(default=None, max_length=64)
    barcode_type: BarcodeType | None = None
    package_note: str | None = None


class SkuOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    volume_ml: int
    barcode: str | None
    barcode_type: BarcodeType | None
    package_note: str | None


# --- 제품 -------------------------------------------------------------------


class ProductBase(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    name_en: str | None = Field(default=None, max_length=300)
    category_id: uuid.UUID | None = None
    producer_id: uuid.UUID | None = None
    country: str | None = Field(default=None, max_length=80)
    region: str | None = Field(default=None, max_length=120)
    abv: Decimal | None = Field(default=None, ge=0, le=100, description="도수(%)")
    vintage: int | None = Field(default=None, ge=1800, le=2200)
    age_years: Decimal | None = Field(default=None, ge=0)
    # 레거시 실측이 0.5 단위 6점 만점이었다(`docs/legacy-schema.md` §4.8).
    personal_rating: Decimal | None = Field(default=None, gt=0, le=6)
    note: str | None = None


class ProductCreate(ProductBase):
    """제품 생성. 규격을 함께 만들 수 있다.

    4계층 입력 부담을 줄이려면 한 번의 요청으로 제품과 규격을 함께 만들 수 있어야 한다
    (`docs/plan.md` Task 10 주의사항).
    """

    variety_names: list[str] = Field(default_factory=list, max_length=20)
    skus: list[SkuCreate] = Field(default_factory=list, max_length=20)


class ProductUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    name_en: str | None = Field(default=None, max_length=300)
    category_id: uuid.UUID | None = None
    producer_id: uuid.UUID | None = None
    country: str | None = Field(default=None, max_length=80)
    region: str | None = Field(default=None, max_length=120)
    abv: Decimal | None = Field(default=None, ge=0, le=100)
    vintage: int | None = Field(default=None, ge=1800, le=2200)
    age_years: Decimal | None = Field(default=None, ge=0)
    personal_rating: Decimal | None = Field(default=None, gt=0, le=6)
    note: str | None = None
    variety_names: list[str] | None = Field(default=None, max_length=20)


class ProductMetricsOut(BaseModel):
    """파생 지표. 저장하지 않고 매번 계산한다(`docs/architecture.md` §3).

    금액이 `null` 인 것은 0원이 아니라 **가격 정보가 없다**는 뜻이다.
    """

    purchased_count: int = 0
    consumed_count: int = 0
    in_stock_count: int = 0
    unopened_count: int = 0
    opened_count: int = 0
    gifted_count: int = 0
    sold_count: int = 0
    avg_list_price: Decimal | None = None
    avg_paid_price: Decimal | None = None
    price_per_100ml: Decimal | None = Field(
        default=None, description="정가 기준. 레거시 통계와 일치시키기 위한 결정"
    )
    price_per_100ml_paid: Decimal | None = None
    list_total: Decimal | None = None
    paid_total: Decimal | None = None
    discount_rate: Decimal | None = None
    total_volume_ml: int = 0
    inventory_value_at_cost: Decimal | None = None


class ProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    name_en: str | None
    category_id: uuid.UUID | None
    category_path: list[str] = Field(default_factory=list)
    producer_id: uuid.UUID | None
    producer_name: str | None = None
    country: str | None
    region: str | None
    abv: Decimal | None
    vintage: int | None
    age_years: Decimal | None
    personal_rating: Decimal | None
    note: str | None
    varieties: list[str] = Field(default_factory=list)
    skus: list[SkuOut] = Field(default_factory=list)
    metrics: ProductMetricsOut = Field(default_factory=ProductMetricsOut)


class ProductPage(BaseModel):
    """커서 페이지네이션 응답."""

    items: list[ProductOut]
    next_cursor: str | None = Field(
        default=None, description="null 이면 마지막 페이지. 그대로 다음 요청에 실어 보낸다"
    )


# --- 구매처 -----------------------------------------------------------------


class VendorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: VendorKind = VendorKind.OTHER
    url: str | None = None
    note: str | None = None


class VendorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    kind: VendorKind | None = None
    url: str | None = None
    note: str | None = None


class VendorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    kind: VendorKind
    url: str | None
    note: str | None
    purchase_count: int = 0


# --- 구매 건 ----------------------------------------------------------------


class PurchaseCreate(BaseModel):
    """구매 건 생성.

    금액은 **병당 단가**로 받는다. 레거시는 총액을 저장했지만 구매 건을 쪼갤 때 단가가
    보존되어야 한다(`docs/architecture.md` §2.3 `purchase`).
    """

    sku_id: uuid.UUID
    vendor_id: uuid.UUID | None = None
    purchased_on: datetime.date | None = None
    quantity: int = Field(default=1, gt=0, le=1000)
    unit_list_price: Decimal | None = Field(default=None, ge=0)
    unit_paid_price: Decimal | None = Field(default=None, ge=0)
    currency: str = Field(default="KRW", min_length=3, max_length=3)
    fx_rate: Decimal | None = Field(default=None, gt=0)
    foreign_unit_price: Decimal | None = Field(default=None, ge=0)
    discount_note: str | None = None
    # 병 레코드를 함께 만들 것인지. 임포트는 상태별 개수를 직접 지정하므로 끌 수 있어야 한다.
    create_bottles: bool = True

    @model_validator(mode="after")
    def _foreign_price_needs_rate(self) -> PurchaseCreate:
        if self.foreign_unit_price is not None and self.fx_rate is None:
            raise ValueError("외화 가격을 넣으려면 fx_rate 가 필요합니다")
        return self


class PurchaseUpdate(BaseModel):
    vendor_id: uuid.UUID | None = None
    purchased_on: datetime.date | None = None
    unit_list_price: Decimal | None = Field(default=None, ge=0)
    unit_paid_price: Decimal | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    fx_rate: Decimal | None = Field(default=None, gt=0)
    foreign_unit_price: Decimal | None = Field(default=None, ge=0)
    discount_note: str | None = None


class PurchaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sku_id: uuid.UUID
    volume_ml: int | None = None
    vendor_id: uuid.UUID | None
    vendor_name: str | None = None
    purchased_on: datetime.date | None
    quantity: int
    unit_list_price: Decimal | None
    unit_paid_price: Decimal | None
    list_total: Decimal | None = None
    paid_total: Decimal | None = None
    currency: str
    fx_rate: Decimal | None
    foreign_unit_price: Decimal | None
    discount_note: str | None
    import_note: str | None = None
    bottle_count: int = 0


class PurchaseSplitPart(BaseModel):
    """분할 후 한 조각."""

    quantity: int = Field(gt=0)
    vendor_id: uuid.UUID | None = None
    purchased_on: datetime.date | None = None
    unit_list_price: Decimal | None = Field(default=None, ge=0)
    unit_paid_price: Decimal | None = Field(default=None, ge=0)


class PurchaseSplit(BaseModel):
    """구매 건 분할 요청.

    레거시 임포트가 만든 합성 구매 건을 실제 구매처·가격별로 쪼개는 경로다. 레거시 28행이
    한 셀에 여러 구매처를 담고 있었다(`docs/legacy-schema.md` §4.6).
    """

    parts: list[PurchaseSplitPart] = Field(min_length=2, max_length=20)


class BottleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    purchase_id: uuid.UUID
    label_no: int
    status: BottleStatus
    opened_on: datetime.date | None
    finished_on: datetime.date | None
    remaining_ml: int | None
    storage_location: str | None
    note: str | None
