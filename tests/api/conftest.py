"""API 테스트 fixture.

실제 PostgreSQL 에 연결한 `TestClient` 를 제공한다. 라우터·스키마·쿼리가 함께 동작하는지가
검증 대상이므로 DB 를 목킹하지 않는다. 목킹하면 SQL 오류를 못 잡는다.

인증도 **우회하지 않는다.** `api_client` 는 실제 `/auth/setup` 을 호출해 세션 쿠키를 받는다.
의존성을 오버라이드해 인증을 끄면, 인증이 깨져도 테스트가 초록색이라 알 수 없다.

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
from sooljang.api.routes.auth import CSRF_HEADER
from sooljang.application.auth import reset_rate_limiter
from sooljang.infrastructure.database import models as _models  # noqa: F401 - 메타데이터 등록
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.session import reset_database_state

DEFAULT_TEST_DATABASE_URL = "postgresql+psycopg://sooljang:sooljang@127.0.0.1:5432/sooljang_test"

#: 테스트 소유자 계정. 실제 로그인 흐름을 거치므로 비밀번호 정책을 만족해야 한다.
TEST_EMAIL = "owner@example.com"
TEST_PASSWORD = "sooljang-test-1234"
TEST_DISPLAY_NAME = "테스트 소유자"


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
def anon_client() -> Iterator[TestClient]:
    """로그인하지 않은 클라이언트. 인증이 실제로 막는지 확인하는 데 쓴다."""
    asyncio.run(_reset_schema())
    reset_database_state()
    reset_rate_limiter()

    with TestClient(create_app(), raise_server_exceptions=False) as client:
        yield client

    reset_database_state()


@pytest.fixture
def api_client(anon_client: TestClient) -> TestClient:
    """소유자로 로그인한 클라이언트.

    `/auth/setup` 으로 최초 사용자를 만들고 세션 쿠키를 받는다. CSRF 토큰은 쓰기 요청마다
    필요하므로 기본 헤더에 심는다.
    """
    response = anon_client.post(
        f"{API_PREFIX}/auth/setup",
        json={
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "display_name": TEST_DISPLAY_NAME,
        },
    )
    assert response.status_code == 201, response.text
    anon_client.headers[CSRF_HEADER] = response.json()["csrf_token"]
    return anon_client


@pytest.fixture
def api_user_id(api_client: TestClient) -> uuid.UUID:
    """로그인한 사용자 id. 데이터를 직접 넣는 테스트가 스코프를 맞추는 데 쓴다."""
    response = api_client.get(f"{API_PREFIX}/auth/me")
    assert response.status_code == 200, response.text
    return uuid.UUID(response.json()["id"])


@pytest.fixture
def prefix() -> str:
    return API_PREFIX
