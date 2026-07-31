"""실제 PostgreSQL 을 쓰는 테스트용 fixture.

각 테스트를 트랜잭션으로 감싸고 끝에 롤백한다. 테이블을 매번 지우고 다시 만드는 것보다
빠르고, 테스트 간 상태가 새지 않는다.
"""

import os
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, async_sessionmaker

from sooljang.infrastructure.database import models as _models  # noqa: F401 - 메타데이터 등록
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.session import get_engine

# 위 models import 가 없으면 Base.metadata 가 비어 있어 create_all 이 아무 테이블도 만들지
# 않고, 그 사실이 조용히 통과한다.

DEFAULT_TEST_DATABASE_URL = "postgresql+psycopg://sooljang:sooljang@127.0.0.1:5432/sooljang_test"


def database_url() -> str:
    return os.environ.get("SOOLJANG_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def connection() -> AsyncIterator[AsyncConnection]:
    """스키마가 준비된 연결. 마이그레이션 대신 metadata 로 만든다.

    마이그레이션 왕복은 `alembic` 을 직접 돌리는 별도 테스트가 검증한다. 여기서는 모델
    정의가 곧 스키마라는 전제로 빠르게 만든다. 둘이 어긋나면 CI 의 `alembic check` 가
    드리프트로 잡아낸다.
    """
    engine = get_engine()
    async with engine.begin() as setup:
        await setup.run_sync(lambda sync: Base.metadata.drop_all(sync, checkfirst=True))
        await setup.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await setup.run_sync(Base.metadata.create_all)

    async with engine.connect() as conn:
        transaction = await conn.begin()
        try:
            yield conn
        finally:
            await transaction.rollback()


@pytest.fixture
async def session(connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    """테스트 종료 시 롤백되는 세션."""
    factory = async_sessionmaker(
        bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    async with factory() as db_session:
        yield db_session


@pytest.fixture
def user_id() -> uuid.UUID:
    """테스트용 사용자 식별자. 모든 레코드가 이 값으로 스코프된다."""
    return uuid.UUID("00000000-0000-0000-0000-000000000001")


@pytest.fixture
def other_user_id() -> uuid.UUID:
    """스코프 격리 검증용 두 번째 사용자."""
    return uuid.UUID("00000000-0000-0000-0000-000000000002")
