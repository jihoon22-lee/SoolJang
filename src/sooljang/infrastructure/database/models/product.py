"""제품과 규격 모델.

`product` 는 논리적 제품(이름·빈티지·도수), `sku` 는 용량별 단위다. 둘을 분리하는 이유는
같은 술의 700ml 와 1L 를 구분해야 바코드 매칭과 100ml당 가격이 정확해지기 때문이다
(`docs/architecture.md` §9.3).
"""

import enum
import uuid
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
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
from sooljang.infrastructure.database.models.category import Category, Producer, Variety

#: 개인 평점 스케일. 레거시 실측이 0.5 단위 6점 만점이었다
#: (`docs/legacy-schema.md` §4.8).
MAX_PERSONAL_RATING = Decimal(6)


class BarcodeType(enum.StrEnum):
    """바코드 규격. RCN 은 사내용이라 제조사별로 중복될 수 있어 구분해 둔다."""

    EAN13 = "ean13"
    UPCA = "upca"
    EAN8 = "ean8"
    RCN = "rcn"
    OTHER = "other"


class Product(Base, EntityMixin):
    """제품. 이름·빈티지·도수로 식별되는 논리적 단위."""

    __tablename__ = "product"

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    name_en: Mapped[str | None] = mapped_column(String(300), default=None)
    # 중복 판정 키. 공백·구두점·대소문자를 정규화한 값을 저장한다.
    normalized_name: Mapped[str] = mapped_column(String(300), nullable=False)

    category_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("category.id", ondelete="RESTRICT"), default=None
    )
    producer_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("producer.id", ondelete="SET NULL"), default=None
    )

    country: Mapped[str | None] = mapped_column(String(80), default=None)
    region: Mapped[str | None] = mapped_column(String(120), default=None)
    abv: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), default=None)
    vintage: Mapped[int | None] = mapped_column(Integer, default=None)
    age_years: Mapped[Decimal | None] = mapped_column(Numeric(4, 1), default=None)

    # 제품 수준 총평. 시음 세션별 평점과 별개로 두어 레거시 `내 평점`·`느낀 점` 을 손실 없이
    # 받고, 세션이 쌓이면 세션 평균을 함께 보여준다.
    personal_rating: Mapped[Decimal | None] = mapped_column(Numeric(3, 1), default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    # 레거시 원문 보존. 임포트가 해석하지 못한 정보를 잃지 않기 위한 자리다.
    import_note: Mapped[str | None] = mapped_column(Text, default=None)

    category: Mapped[Category | None] = relationship("Category", lazy="selectin")
    producer: Mapped[Producer | None] = relationship("Producer", lazy="selectin")
    skus: Mapped[list[Sku]] = relationship(
        "Sku", back_populates="product", cascade="all, delete-orphan"
    )
    varieties: Mapped[list[ProductVariety]] = relationship(
        "ProductVariety", back_populates="product", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("abv IS NULL OR (abv >= 0 AND abv <= 100)", name="abv_range"),
        CheckConstraint("vintage IS NULL OR (vintage BETWEEN 1800 AND 2200)", name="vintage_range"),
        CheckConstraint("age_years IS NULL OR age_years >= 0", name="age_years_non_negative"),
        CheckConstraint(
            "personal_rating IS NULL OR (personal_rating > 0 AND personal_rating <= 6)",
            name="personal_rating_range",
        ),
        # 목록 기본 조회 경로.
        Index("ix_product_user_id_deleted_at_category_id", "user_id", "deleted_at", "category_id"),
        # 중복 판정. 같은 이름·빈티지·도수는 한 제품이다.
        Index(
            "uq_product_identity",
            "user_id",
            "normalized_name",
            "vintage",
            "abv",
            unique=True,
            postgresql_where="deleted_at IS NULL",
        ),
        # 한글 부분 문자열 검색. pg_trgm GIN 인덱스가 ILIKE '%...%' 를 가속한다.
        Index(
            "ix_product_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
    )

    def __repr__(self) -> str:
        return f"<Product {self.name!r} vintage={self.vintage}>"


class ProductVariety(Base, EntityMixin):
    """제품과 품종의 다대다 연결.

    레거시 41행이 셀 내 개행으로 여러 품종을 담고 있었다. 맥주의 `Trappist Ale` +
    `Quadrupel` 처럼 복수 값이 정상이다.
    """

    __tablename__ = "product_variety"

    product_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("product.id", ondelete="CASCADE"), nullable=False
    )
    variety_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("variety.id", ondelete="CASCADE"), nullable=False
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped[Product] = relationship("Product", back_populates="varieties")
    variety: Mapped[Variety] = relationship("Variety", lazy="selectin")

    __table_args__ = (
        UniqueConstraint(
            "product_id", "variety_id", name="uq_product_variety_product_id_variety_id"
        ),
    )


class Sku(Base, EntityMixin):
    """규격. 용량별 단위이며 바코드 매칭과 단위 가격 계산의 기준이다."""

    __tablename__ = "sku"

    product_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("product.id", ondelete="CASCADE"), nullable=False
    )
    volume_ml: Mapped[int] = mapped_column(Integer, nullable=False)
    barcode: Mapped[str | None] = mapped_column(String(64), default=None)
    barcode_type: Mapped[BarcodeType | None] = mapped_column(
        str_enum_column(BarcodeType, "barcode_type"), default=None
    )
    package_note: Mapped[str | None] = mapped_column(Text, default=None)

    product: Mapped[Product] = relationship("Product", back_populates="skus")

    __table_args__ = (
        CheckConstraint("volume_ml > 0", name="volume_positive"),
        UniqueConstraint("product_id", "volume_ml", name="uq_sku_product_id_volume_ml"),
        # 바코드는 사용자 범위에서 유일하다. NULL 은 여러 개 있을 수 있다.
        Index(
            "uq_sku_user_id_barcode",
            "user_id",
            "barcode",
            unique=True,
            postgresql_where="barcode IS NOT NULL AND deleted_at IS NULL",
        ),
    )

    def __repr__(self) -> str:
        return f"<Sku product={self.product_id} volume={self.volume_ml}ml>"
