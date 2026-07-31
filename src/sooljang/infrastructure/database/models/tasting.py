"""시음 기록 모델.

엑셀에는 "내 평점" 한 칸만 있었다. 같은 술을 여러 번 마셔도 마지막 인상 하나만 남고, 처음
열었을 때와 반년 뒤가 어떻게 달랐는지는 사라졌다. 시음을 **세션 단위**로 기록하면 평점 변화와
잔량 소진을 함께 추적할 수 있다.

잔량은 세션에 저장한 `poured_ml` 합계로 계산할 수도 있지만, 병에 `remaining_ml` 을 두는
쪽을 택했다. 병을 흘리거나 나눠 준 경우처럼 세션 없이 줄어드는 일이 있어서다. 세션 기록 시
서비스 계층이 두 값을 함께 갱신한다.
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

#: 내 평점 상한. 레거시 시트 실측 결과 **6점 만점 0.5 단위**였다(5점이 아니다).
MAX_RATING = Decimal("6.0")
RATING_STEP = Decimal("0.5")


class AttachmentKind(enum.StrEnum):
    """첨부 종류.

    라벨 사진과 시음 사진을 구분한다. 라벨은 제품 식별에 쓰이고(Task 17 OCR 입력),
    시음 사진은 그 자리의 기록이다.
    """

    LABEL = "label"
    TASTING = "tasting"
    BOTTLE = "bottle"
    OTHER = "other"


class TastingSession(Base, EntityMixin):
    """한 번의 시음.

    병 없이도 기록할 수 있어야 한다. 바에서 잔으로 마신 술은 내 병이 아니지만 평점과 노트는
    남기고 싶다. 그래서 `bottle_id` 는 NULL 을 허용하고, 대신 `sku_id` 로 무엇을 마셨는지
    가리킨다.
    """

    __tablename__ = "tasting_session"

    #: 내 병을 마신 경우. 잔으로 마신 술은 NULL 이다.
    bottle_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("bottle.id", ondelete="CASCADE"), default=None
    )
    #: 무엇을 마셨는지. 병이 없어도 이건 있어야 통계에 들어간다.
    sku_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("sku.id", ondelete="CASCADE"), nullable=False
    )
    tasted_on: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    #: 따른 양. 병에서 마신 경우 잔량에서 차감한다.
    poured_ml: Mapped[int | None] = mapped_column(Integer, default=None)
    #: 6점 만점 0.5 단위. 레거시 시트와 같은 척도를 유지한다.
    rating: Mapped[Decimal | None] = mapped_column(Numeric(3, 1), default=None)

    nose: Mapped[str | None] = mapped_column(Text, default=None)
    palate: Mapped[str | None] = mapped_column(Text, default=None)
    finish: Mapped[str | None] = mapped_column(Text, default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    place: Mapped[str | None] = mapped_column(String(200), default=None)
    #: 동석자. 자유 텍스트로 둔다. 사람을 별도 테이블로 관리할 요구가 아직 없다.
    companions: Mapped[str | None] = mapped_column(Text, default=None)

    bottle: Mapped[object | None] = relationship("Bottle", lazy="selectin")
    attachments: Mapped[list[Attachment]] = relationship(
        "Attachment",
        back_populates="tasting_session",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    __table_args__ = (
        CheckConstraint("poured_ml IS NULL OR poured_ml > 0", name="poured_ml_positive"),
        # 평점은 0.5 단위여야 한다. 3.7 같은 값이 들어오면 레거시 통계와 대조할 수 없다.
        CheckConstraint(
            "rating IS NULL OR (rating >= 0 AND rating <= 6.0"
            " AND (rating * 2) = floor(rating * 2))",
            name="rating_half_step_within_range",
        ),
        Index("ix_tasting_session_bottle_id_tasted_on", "bottle_id", "tasted_on"),
        Index("ix_tasting_session_sku_id_tasted_on", "sku_id", "tasted_on"),
        Index("ix_tasting_session_user_id_tasted_on", "user_id", "tasted_on"),
    )

    def __repr__(self) -> str:
        return f"<TastingSession sku={self.sku_id} on={self.tasted_on} rating={self.rating}>"


class Attachment(Base, EntityMixin):
    """첨부 파일 메타데이터.

    파일 자체는 DB 에 넣지 않는다. 바이너리를 DB 에 두면 백업 크기가 폭증하고, 이미지 하나가
    수 MB 라 `pg_dump` 가 실용적이지 않게 된다. 경로만 저장하고 파일은 디스크에 둔다.

    `sha256` 을 저장해 같은 사진을 두 번 올리면 재사용한다. 폰에서 같은 사진을 다시 고르는
    일이 흔하다.
    """

    __tablename__ = "attachment"

    kind: Mapped[AttachmentKind] = mapped_column(
        str_enum_column(AttachmentKind, "attachment_kind"),
        nullable=False,
        default=AttachmentKind.OTHER,
    )
    #: 저장소 상대 경로. 절대 경로를 저장하면 배포 위치가 바뀔 때 전부 깨진다.
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(300), default=None)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    #: 내용 해시. 같은 파일을 재사용해 중복 저장을 막는다.
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    caption: Mapped[str | None] = mapped_column(Text, default=None)

    #: 무엇에 붙은 첨부인지. 셋 중 정확히 하나만 채운다.
    product_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("product.id", ondelete="CASCADE"), default=None
    )
    bottle_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("bottle.id", ondelete="CASCADE"), default=None
    )
    tasting_session_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("tasting_session.id", ondelete="CASCADE"), default=None
    )

    tasting_session: Mapped[TastingSession | None] = relationship(
        "TastingSession", back_populates="attachments"
    )

    __table_args__ = (
        CheckConstraint("byte_size > 0", name="byte_size_positive"),
        # 첨부는 정확히 하나의 대상에 붙는다. 둘 이상이면 어디에 표시할지 모호하고, 없으면
        # 고아 레코드가 된다.
        CheckConstraint(
            "(product_id IS NOT NULL)::int + (bottle_id IS NOT NULL)::int"
            " + (tasting_session_id IS NOT NULL)::int = 1",
            name="attachment_has_exactly_one_owner",
        ),
        UniqueConstraint("user_id", "sha256", "kind", name="uq_attachment_user_sha256_kind"),
        Index("ix_attachment_product_id", "product_id"),
        Index("ix_attachment_bottle_id", "bottle_id"),
        Index("ix_attachment_tasting_session_id", "tasting_session_id"),
    )

    def __repr__(self) -> str:
        return f"<Attachment {self.kind} {self.storage_path!r}>"
