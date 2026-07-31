"""헬스체크 엔드포인트 테스트."""

import pytest
from fastapi.testclient import TestClient

from sooljang import __version__
from sooljang.api.app import API_PREFIX, create_app
from sooljang.infrastructure.database import session as session_module


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), raise_server_exceptions=False)


async def _connected() -> bool:
    return True


async def _disconnected() -> bool:
    return False


async def _revision() -> str | None:
    return "0001_enable_pg_trgm"


def test_health_reports_ok_when_database_is_reachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_module, "check_connection", _connected)
    monkeypatch.setattr(session_module, "get_migration_revision", _revision)
    monkeypatch.setattr("sooljang.api.routes.health.check_connection", _connected)
    monkeypatch.setattr("sooljang.api.routes.health.get_migration_revision", _revision)

    response = client.get(f"{API_PREFIX}/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database_connected"] is True
    assert body["migration_revision"] == "0001_enable_pg_trgm"
    assert body["version"] == __version__
    assert body["environment"] == "test"


def test_health_reports_degraded_with_503_when_database_is_unreachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sooljang.api.routes.health.check_connection", _disconnected)

    response = client.get(f"{API_PREFIX}/health")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["database_connected"] is False
    assert body["migration_revision"] is None


def test_openapi_schema_is_served_under_versioned_prefix(client: TestClient) -> None:
    response = client.get(f"{API_PREFIX}/openapi.json")

    assert response.status_code == 200
    assert f"{API_PREFIX}/health" in response.json()["paths"]
