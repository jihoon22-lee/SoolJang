"""마이그레이션 정합성 테스트.

CI 의 `migration-check` 잡이 같은 검증을 하지만, 로컬에서도 모델을 고칠 때 바로 잡히도록
테스트로 고정한다. 마이그레이션을 잊고 모델만 바꾸는 것이 가장 흔한 실수다.
"""

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect

from sooljang.infrastructure.database import models as _models  # noqa: F401 - 메타데이터 등록
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.session import get_engine

pytestmark = pytest.mark.requires_db

EXPECTED_TABLES = {
    "bottle",
    "category",
    "producer",
    "product",
    "product_variety",
    "purchase",
    "sku",
    "variety",
    "vendor",
    "conflict_log",
    "outbox_receipt",
    "sync_cursor",
    # 서버 전용 설정(Task 17). 의도적으로 SYNC_TARGET_TABLES 에는 넣지 않는다 — API 키가
    # 클라이언트 IndexedDB 로 미러링되면 안 된다.
    "llm_setting",
    # 통계 v2(Task 20). 통계 v2 전체가 온라인 전용이라 이것도 SYNC_TARGET_TABLES 에 넣지
    # 않는다 — 피벗 재실행 자체가 서버 DB 조회를 전제한다.
    "saved_view",
}

#: 동기화 델타 조회 기준(`docs/architecture.md` §2.4) — 이 12개 테이블 모두
#: `(user_id, updated_at)` 인덱스가 있어야 한다.
SYNC_TARGET_TABLES = {
    "category",
    "producer",
    "variety",
    "product",
    "product_variety",
    "sku",
    "vendor",
    "purchase",
    "bottle",
    "tasting_session",
    "attachment",
    "conflict_log",
}


async def test_metadata_defines_all_expected_tables() -> None:
    assert set(Base.metadata.tables) >= EXPECTED_TABLES


async def test_schema_created_from_metadata_has_no_drift() -> None:
    """모델 정의와 실제 스키마가 일치해야 한다.

    `alembic check` 는 마이그레이션 기준으로 검사하고, 이 테스트는 metadata 기준으로
    검사한다. 둘 다 통과해야 마이그레이션과 모델이 함께 맞는 것이다.
    """
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync: Base.metadata.drop_all(sync, checkfirst=True))
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await conn.run_sync(Base.metadata.create_all)

    async with engine.connect() as conn:
        diff = await conn.run_sync(
            lambda sync: compare_metadata(MigrationContext.configure(sync), Base.metadata)
        )

    assert diff == []


async def test_trigram_index_exists_on_product_name() -> None:
    """한글 부분 문자열 검색이 인덱스를 타야 한다."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync: Base.metadata.drop_all(sync, checkfirst=True))
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await conn.run_sync(Base.metadata.create_all)

    async with engine.connect() as conn:
        indexes = await conn.run_sync(lambda sync: inspect(sync).get_indexes("product"))

    trigram = next((index for index in indexes if index["name"] == "ix_product_name_trgm"), None)
    assert trigram is not None
    assert trigram.get("dialect_options", {}).get("postgresql_using") == "gin"


async def test_sync_target_tables_have_user_id_updated_at_index() -> None:
    """`GET /sync` 델타 조회가 이 인덱스를 타야 한다. 없으면 순차 스캔이 된다."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync: Base.metadata.drop_all(sync, checkfirst=True))
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await conn.run_sync(Base.metadata.create_all)

    async with engine.connect() as conn:
        for table in SYNC_TARGET_TABLES:
            indexes = await conn.run_sync(lambda sync, t=table: inspect(sync).get_indexes(t))
            matching = [
                index
                for index in indexes
                if set(index["column_names"]) == {"user_id", "updated_at"}
            ]
            assert matching, f"{table} 에 (user_id, updated_at) 인덱스가 없습니다"


async def test_partial_unique_indexes_exclude_soft_deleted_rows() -> None:
    """soft delete 후 같은 이름을 다시 만들 수 있어야 한다."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync: Base.metadata.drop_all(sync, checkfirst=True))
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await conn.run_sync(Base.metadata.create_all)

    async with engine.connect() as conn:
        category_indexes = await conn.run_sync(lambda sync: inspect(sync).get_indexes("category"))

    unique = next(
        index for index in category_indexes if index["name"] == "uq_category_user_id_parent_id_name"
    )
    assert unique["unique"] is True
    assert "deleted_at IS NULL" in str(unique.get("dialect_options", {}))
