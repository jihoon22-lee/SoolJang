"""주종 카테고리 모델.

주종 계층은 **고정 분류가 아니라 사용자 데이터**다. 최상위부터 말단까지 어느 깊이에서든
추가·이름 변경·이동·순서 변경·삭제·병합이 가능하다(`docs/architecture.md` §2.3).

깊이 제한을 두지 않는다. 대신 두 불변식을 애플리케이션 계층에서 강제한다.

1. 순환 금지 — 어떤 카테고리도 자기 자신의 조상이 될 수 없다
2. 깊이 상한 `MAX_CATEGORY_DEPTH` — 폭주하는 중첩을 막는 안전장치

`depth` 를 컬럼으로 저장하지 않는다. 이동이 자유로워 매 이동마다 서브트리 전체를 갱신해야
하고, 그 값이 어긋나면 조회가 조용히 틀린다. 깊이는 조회 시 계산한다.
"""

import uuid

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from sooljang.infrastructure.database.base import Base, EntityMixin


class Category(Base, EntityMixin):
    """주종. 자기참조 계층이며 사용자가 자유롭게 관리한다."""

    __tablename__ = "category"

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("category.id", ondelete="RESTRICT"),
        default=None,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(160), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 기본 시드로 만들어진 항목인지. "기본값으로 되돌리기" 와 시드 upsert 판정에 쓴다.
    is_seeded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    parent: Mapped[Category | None] = relationship(
        "Category", remote_side="Category.id", back_populates="children"
    )
    children: Mapped[list[Category]] = relationship(
        "Category", back_populates="parent", order_by="Category.sort_order"
    )

    __table_args__ = (
        # 같은 부모 아래 이름 중복 금지. soft delete 된 항목은 제외해야 삭제 후 같은
        # 이름을 다시 만들 수 있다.
        Index(
            "uq_category_user_id_parent_id_name",
            "user_id",
            "parent_id",
            "name",
            unique=True,
            postgresql_where="deleted_at IS NULL",
        ),
        Index("ix_category_user_id_parent_id", "user_id", "parent_id"),
    )

    def __repr__(self) -> str:
        return f"<Category {self.name!r} parent={self.parent_id}>"


class Producer(Base, EntityMixin):
    """생산자. 증류소·와이너리·브루어리·양조장을 구분 없이 담는다.

    구분을 강제하지 않는 이유는 주종을 넘나드는 생산자가 있고(사케 양조장이 소주를 만드는
    등), 분류를 강제하면 사용자가 맞지 않는 값을 고르게 되기 때문이다.
    """

    __tablename__ = "producer"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    name_en: Mapped[str | None] = mapped_column(String(200), default=None)
    country: Mapped[str | None] = mapped_column(String(80), default=None)
    region: Mapped[str | None] = mapped_column(String(120), default=None)
    website: Mapped[str | None] = mapped_column(Text, default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_producer_user_id_name"),)

    def __repr__(self) -> str:
        return f"<Producer {self.name!r}>"


class Variety(Base, EntityMixin):
    """품종·스타일·향형.

    레거시 `품종` 컬럼은 다목적이다. 와인 품종, 맥주 스타일, 브랜디 등급, 백주 향형이 같은
    컬럼에 섞여 있다(`docs/legacy-schema.md` §4.8). 단일 어휘로 수용하고 의미는 주종 문맥으로
    해석한다. 섣부른 분류는 원본 정보를 잃는다.
    """

    __tablename__ = "variety"

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, default=None)

    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_variety_user_id_name"),)

    def __repr__(self) -> str:
        return f"<Variety {self.name!r}>"
