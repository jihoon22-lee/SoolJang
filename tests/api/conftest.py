"""API 테스트 fixture.

실제 PostgreSQL 에 연결한 `TestClient` 를 제공한다. 라우터·스키마·쿼리가 함께 동작하는지가
검증 대상이므로 DB 를 목킹하지 않는다. 목킹하면 SQL 오류를 못 잡는다.

스키마 초기화는 **별도 엔진으로 분리**해 `asyncio.run` 안에서 끝낸다. `TestClient` 는 자체
이벤트 루프(anyio portal)를 별도 스레드에서 돌리므로, 애플리케이션이 쓰는 엔진은 그 루프에서
만들어져야 한다. 같은 엔진을 두 루프에서 쓰면 커넥션 풀이 깨진다.
"""

import asyncio
import os
import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine

from sooljang.api.app import API_PREFIX, create_app
from sooljang.infrastructure.database import models as _models  # noqa: F401 - 메타데이터 등록
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.session import reset_database_state

DEFAULT_TEST_DATABASE_URL = "postgresql+psycopg://sooljang:sooljang@127.0.0.1:5432/sooljang_test"

#: `deps.current_user_id` 가 설정에서 읽는 기본 사용자와 같아야 한다.
API_USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


def _database_url() -> str:
    return os.environ.get("SOOLJANG_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


async def _reset_schema() -> None:
    engine = create_async_engine(_database_url())
    try:
        async with engine.begin() as conn:
            await conn.run_sync(lambda sync: Base.metadata.drop_all(sync, checkfirst=True))
            await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
            await conn.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()


@pytest.fixture
def api_client() -> Iterator[TestClient]:
    """스키마를 새로 만든 뒤 요청마다 커밋하는 클라이언트.

    라우터가 커밋에 의존하므로(`deps.db_session`) 트랜잭션 롤백 격리를 쓸 수 없다. 대신
    테스트 시작 시 스키마를 다시 만들어 격리한다.
    """
    asyncio.run(_reset_schema())
    # 캐시된 엔진을 폐기해 애플리케이션이 TestClient 의 루프에서 새로 만들게 한다.
    reset_database_state()

    with TestClient(create_app(), raise_server_exceptions=False) as client:
        yield client

    reset_database_state()


@pytest.fixture
def prefix() -> str:
    return API_PREFIX
