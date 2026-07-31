"""구매처·구매 건·개별 병 모델.

`purchase` 가 독립 엔티티인 것이 이 프로젝트의 핵심이다. 엑셀은 한 행에 제품 정보와 집계된
병수, 단일 구매처만 담아 같은 술을 다른 시점·구매처·가격에 산 이력이 소실됐다
(`docs/legacy-schema.md` §6).

금액은 **병당 단가**로 저장한다. 레거시는 총액을 저장했지만, 구매 건을 쪼갤 때 단가가
보존되어야 하고 총액은 `unit_price × quantity` 로 언제든 복원된다.
"""

import datetime
import enum
import uuid
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from sooljang.infrastructure.database.base import Base, EntityMixin, str_enum_column
from sooljang.infrastructure.database.models.product import Sku


class VendorKind(enum.StrEnum):
    """구매처 종류. 레거시 실측 82곳을 분류할 수 있는 범위로 정했다."""

    MART = "mart"
    ONLINE = "online"
    DUTY_FREE = "duty_free"
    BOTTLE_SHOP = "bottle_shop"
    BAR = "bar"
    BREWERY = "brewery"
    EVENT = "event"
    GIFT = "gift"
    OTHER = "other"


class BottleStatus(enum.StrEnum):
    """개별 병의 상태."""

    UNOPENED = "unopened"
    OPEN = "open"
    FINISHED = "finished"
    GIFTED = "gifted"
    SOLD = "sold"


#: 재고로 세는 상태. 증여·판매·소진은 재고가 아니다.
IN_STOCK_STATUSES = frozenset({BottleStatus.UNOPENED, BottleStatus.OPEN})


class Vendor(Base, EntityMixin):
    """구매처."""

    __tablename__ = "vendor"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[VendorKind] = mapped_column(
        str_enum_column(VendorKind, "vendor_kind"),
        nullable=False,
        default=VendorKind.OTHER,
    )
    url: Mapped[str | None] = mapped_column(Text, default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_vendor_user_id_name"),)

    def __repr__(self) -> str:
        return f"<Vendor {self.name!r} kind={self.kind}>"


class Purchase(Base, EntityMixin):
    """구매 건. 한 번의 구매(구매처·가격·병수)를 나타낸다."""

    __tablename__ = "purchase"

    sku_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("sku.id", ondelete="CASCADE"), nullable=False
    )
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendor.id", ondelete="SET NULL"), default=None
    )
    # 레거시에 구매일 컬럼이 없어 NULL 을 허용한다. 임포트한 기록은 날짜를 모른다.
    purchased_on: Mapped[datetime.date | None] = mapped_column(Date, default=None)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # 원화 기준 병당 단가.
    unit_list_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), default=None)
    unit_paid_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), default=None)

    # 외화 구매. 환율은 구매 시점 값으로 고정한다. 현재 환율로 재평가하면 과거 지출액이
    # 매일 바뀌어 통계가 재현되지 않는다.
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KRW")
    fx_rate: Mapped[Decimal | None] = mapped_column(Numeric(14, 6), default=None)
    foreign_unit_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), default=None)

    discount_note: Mapped[str | None] = mapped_column(Text, default=None)
    # 레거시 원문 보존. 자동 분해에 실패한 구매처 문자열 등을 그대로 남긴다.
    import_note: Mapped[str | None] = mapped_column(Text, default=None)

    sku: Mapped[Sku] = relationship("Sku", lazy="selectin")
    vendor: Mapped[Vendor | None] = relationship("Vendor", lazy="selectin")
    bottles: Mapped[list[Bottle]] = relationship(
        "Bottle", back_populates="purchase", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint(
            "unit_list_price IS NULL OR unit_list_price >= 0", name="unit_list_price_non_negative"
        ),
        CheckConstraint(
            "unit_paid_price IS NULL OR unit_paid_price >= 0", name="unit_paid_price_non_negative"
        ),
        CheckConstraint("fx_rate IS NULL OR fx_rate > 0", name="fx_rate_positive"),
        # 외화 표기 가격이 있으면 환율도 있어야 원화 환산을 재현할 수 있다.
        CheckConstraint(
            "foreign_unit_price IS NULL OR fx_rate IS NOT NULL", name="foreign_price_needs_fx_rate"
        ),
        CheckConstraint("char_length(currency) = 3", name="currency_is_iso4217"),
        Index("ix_purchase_sku_id", "sku_id"),
        Index("ix_purchase_user_id_purchased_on", "user_id", "purchased_on"),
    )

    def __repr__(self) -> str:
        return f"<Purchase sku={self.sku_id} qty={self.quantity}>"


class Bottle(Base, EntityMixin):
    """개별 병. 물리적 병 하나에 대응한다."""

    __tablename__ = "bottle"

    purchase_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("purchase.id", ondelete="CASCADE"), nullable=False
    )
    # 구매 건 내 순번. 사용자가 "3병 중 2번째" 를 지목할 수 있게 한다.
    label_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[BottleStatus] = mapped_column(
        str_enum_column(BottleStatus, "bottle_status"),
        nullable=False,
        default=BottleStatus.UNOPENED,
    )
    opened_on: Mapped[datetime.date | None] = mapped_column(Date, default=None)
    finished_on: Mapped[datetime.date | None] = mapped_column(Date, default=None)
    # NULL 이면 미개봉(= 규격 용량 전량). 개봉 후에는 잔량을 명시한다.
    remaining_ml: Mapped[int | None] = mapped_column(Integer, default=None)
    storage_location: Mapped[str | None] = mapped_column(String(200), default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    purchase: Mapped[Purchase] = relationship("Purchase", back_populates="bottles")

    __table_args__ = (
        UniqueConstraint("purchase_id", "label_no", name="uq_bottle_purchase_id_label_no"),
        CheckConstraint("label_no > 0", name="label_no_positive"),
        CheckConstraint("remaining_ml IS NULL OR remaining_ml >= 0", name="remaining_non_negative"),
        # 미개봉이면 개봉일이 없어야 한다.
        CheckConstraint(
            "status <> 'unopened' OR opened_on IS NULL", name="unopened_has_no_opened_on"
        ),
        # 소진이면 잔량이 0이어야 한다.
        CheckConstraint(
            "status <> 'finished' OR remaining_ml = 0", name="finished_has_zero_remaining"
        ),
        # 개봉일과 소진일의 순서.
        CheckConstraint(
            "opened_on IS NULL OR finished_on IS NULL OR finished_on >= opened_on",
            name="finished_after_opened",
        ),
        Index("ix_bottle_purchase_id_status", "purchase_id", "status"),
        Index("ix_bottle_user_id_status", "user_id", "status"),
    )

    @property
    def counts_as_stock(self) -> bool:
        """재고로 세는 상태인지."""
        return self.status in IN_STOCK_STATUSES

    def __repr__(self) -> str:
        return f"<Bottle purchase={self.purchase_id} no={self.label_no} {self.status}>"
