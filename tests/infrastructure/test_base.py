"""ORM 베이스와 공통 컬럼 규약 테스트."""

import uuid

from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import (
    NAMING_CONVENTION,
    Base,
    EntityMixin,
    TimestampMixin,
    new_uuid,
)


class _Sample(Base, EntityMixin):
    __tablename__ = "sample_entity"

    name: Mapped[str] = mapped_column()


def test_new_uuid_returns_unique_values() -> None:
    first, second = new_uuid(), new_uuid()

    assert isinstance(first, uuid.UUID)
    assert first != second


def test_new_uuid_prefers_version_7_when_available() -> None:
    # 표준 라이브러리가 uuid7 을 제공하면 시간 정렬성을 위해 그것을 쓴다.
    expected_version = 7 if hasattr(uuid, "uuid7") else 4
    assert new_uuid().version == expected_version


def test_metadata_uses_explicit_constraint_naming() -> None:
    # 이름 없는 제약은 Alembic downgrade 에서 찾을 수 없어 왕복이 깨진다.
    assert Base.metadata.naming_convention == NAMING_CONVENTION


def test_entity_mixin_provides_common_columns() -> None:
    columns = set(_Sample.__table__.columns.keys())

    assert {"id", "user_id", "created_at", "updated_at", "deleted_at"} <= columns


def test_entity_primary_key_is_uuid_and_user_scoped() -> None:
    table = _Sample.__table__

    assert [column.name for column in table.primary_key] == ["id"]
    assert table.c.user_id.nullable is False
    assert table.c.user_id.index is True


def test_soft_delete_column_is_nullable() -> None:
    # deleted_at 이 NULL 이 아닌 레코드만 삭제로 취급하므로 NULL 을 허용해야 한다.
    assert _Sample.__table__.c.deleted_at.nullable is True


def test_timestamp_mixin_is_reusable_without_identity_columns() -> None:
    assert "created_at" in TimestampMixin.__annotations__
    assert "id" not in TimestampMixin.__annotations__
