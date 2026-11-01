"""테스트 공용 fixture.

`api_client` 계열은 원래 `tests/api/conftest.py` 에만 있었으나, `tests/performance`
등 `tests/api` 밖에서도 실제 인증된 클라이언트가 필요해져(Task 21) 여기로 옮겼다.
pytest 의 conftest 탐색은 테스트 파일 기준 상위 디렉터리로만 올라가므로, 형제
디렉터리(`tests/api`, `tests/performance`)가 함께 쓰려면 공용 지점인 여기에 있어야
한다.
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
from sooljang.config import Settings, get_settings
from sooljang.infrastructure.database import models as _models  # noqa: F401 - 메타데이터 등록
from sooljang.infrastructure.database import session as session_module
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.session import get_engine as _cached_engine
from sooljang.infrastructure.database.session import reset_database_state

TEST_DATABASE_URL = "postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_test"
#: Fernet 은 32바이트 urlsafe base64 키를 요구한다. 테스트 전용 고정값 — 운영 키가 아니다.
TEST_SECRET_KEY = "b_hsHWsTUYKT4jxk9bNuJ7Q8gl_3Fg7AVm4GzMntuEg="

#: 테스트 소유자 계정. 실제 로그인 흐름을 거치므로 비밀번호 정책을 만족해야 한다.
TEST_EMAIL = "owner@example.com"
TEST_PASSWORD = "sooljang-test-1234"
TEST_DISPLAY_NAME = "테스트 소유자"


def _dispose_cached_engine() -> None:
    """캐시를 비우기 전에 엔진 풀의 연결을 닫는다.

    `reset_database_state()` 는 캐시만 비운다. 버린 엔진의 연결은 순환 GC 가 거둘 때까지
    PostgreSQL 연결 슬롯을 잡고 있어, GC 시점이 다른 Python 패치(CI 의 3.14.4)에서는 전체
    실행 중 한도 100 을 넘었다("too many clients"). psycopg 의 close 는 소켓만 닫으므로
    연결을 만든 루프가 끝난 뒤 새 루프에서 닫아도 된다. 테스트가 `get_engine` 을 바꿔
    끼워도 원래 캐시 함수를 본다.
    """
    if _cached_engine.cache_info().currsize:
        asyncio.run(_cached_engine().dispose())


@pytest.fixture(autouse=True)
def _isolated_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """각 테스트가 캐시된 설정·엔진을 공유하지 않게 한다.

    초기화를 setup 단계에서만 수행한다. teardown 에서 초기화하면 monkeypatch 로
    교체된 `get_engine` 이 아직 복원되지 않은 상태에서 `cache_clear` 를 호출해
    실패한다. 매 테스트가 시작 시점에 초기화하므로 격리는 그대로 보장된다.
    """
    monkeypatch.setenv("SOOLJANG_ENVIRONMENT", "test")
    # 개발자의 로컬 `.env` 를 읽지 않게 한다. 읽으면 테스트가 각자의 환경 설정에 따라
    # 통과·실패해 CI 와 결과가 갈린다.
    monkeypatch.setenv("SOOLJANG_ENV_FILE", "")
    monkeypatch.delenv("SOOLJANG_CORS_ORIGINS", raising=False)
    monkeypatch.setenv(
        "SOOLJANG_DATABASE_URL", os.environ.get("SOOLJANG_DATABASE_URL", TEST_DATABASE_URL)
    )
    monkeypatch.setenv("SOOLJANG_SECRET_KEY", TEST_SECRET_KEY)
    # 첨부파일을 리포지토리 밖 임시 디렉터리에 쓴다. 기본값("uploads")을 그대로 두면
    # 테스트가 저장소 작업 트리를 오염시킨다.
    monkeypatch.setenv(
        "SOOLJANG_UPLOAD_DIR", str(tmp_path_factory.mktemp("uploads", numbered=True))
    )
    get_settings.cache_clear()
    _dispose_cached_engine()
    session_module.reset_database_state()


@pytest.fixture
def settings() -> Settings:
    """테스트용 설정."""
    return get_settings()


def _database_url() -> str:
    return os.environ.get("SOOLJANG_DATABASE_URL", TEST_DATABASE_URL)


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

    _dispose_cached_engine()
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
