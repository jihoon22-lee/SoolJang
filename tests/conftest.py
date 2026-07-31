"""테스트 공용 fixture."""

import os

import pytest

from sooljang.config import Settings, get_settings
from sooljang.infrastructure.database import session as session_module

TEST_DATABASE_URL = "postgresql+psycopg://sooljang:sooljang@127.0.0.1:5432/sooljang_test"


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch: pytest.MonkeyPatch) -> None:
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
    get_settings.cache_clear()
    session_module.reset_database_state()


@pytest.fixture
def settings() -> Settings:
    """테스트용 설정."""
    return get_settings()
