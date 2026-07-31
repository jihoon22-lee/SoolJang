"""SQLAlchemy 선언적 베이스와 공통 컬럼 규약.

아키텍처 §2.2 에 정의한 공통 컬럼(`id`, `user_id`, `created_at`, `updated_at`,
`deleted_at`)을 믹스인으로 제공한다. 모든 업무 테이블이 이를 상속해, 동기화 델타
조회와 soft delete 가 테이블마다 다르게 구현되는 것을 막는다.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, MetaData, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# 제약 이름을 규칙으로 고정한다. Alembic 자동 생성 마이그레이션이 이름 없는 제약을
# 만들면 downgrade 에서 이를 찾지 못해 왕복이 깨진다.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_N_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """모든 ORM 모델의 베이스."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def new_uuid() -> uuid.UUID:
    """새 PK 를 생성한다.

    아키텍처 ADR §9.6 에 따라 UUIDv7 을 쓴다. 표준 라이브러리가 v7 을 제공하기
    전까지는 v4 로 동작하되, 교체 지점을 이 함수 하나로 좁혀 둔다.
    """
    uuid7 = getattr(uuid, "uuid7", None)
    return uuid7() if uuid7 is not None else uuid.uuid4()


class TimestampMixin:
    """생성·수정·삭제 시각. `updated_at` 은 동기화 LWW 판정 기준이다."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class EntityMixin(TimestampMixin):
    """업무 테이블 공통 컬럼. `user_id` 는 단일 사용자 시기에도 반드시 채운다."""

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True, default=new_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)


def str_enum_column[E: enum.StrEnum](enum_class: type[E], name: str, *, length: int = 24) -> Enum:
    """`StrEnum` 을 **값** 으로 저장하는 컬럼 타입.

    SQLAlchemy 의 `Enum` 은 기본적으로 멤버 **이름**(`UNOPENED`)을 저장한다. 그러면
    `status <> 'unopened'` 같은 CHECK 제약이 절대 일치하지 않아 조용히 무력화되고, API
    응답 값도 이름과 값이 뒤섞인다. `values_callable` 로 값을 저장하게 고정한다.

    `native_enum=False` 를 쓰는 이유는 PostgreSQL 네이티브 enum 에 값을 추가하려면 별도
    DDL 이 필요해 마이그레이션이 번거로워지기 때문이다.
    """
    return Enum(
        enum_class,
        name=name,
        native_enum=False,
        length=length,
        values_callable=lambda members: [member.value for member in members],
    )
