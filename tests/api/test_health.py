"""스키마 준비 상태와 프로세스 생존은 서로 다른 계약이다."""

import pytest
from fastapi.testclient import TestClient

from sooljang import __version__
from sooljang.api.app import API_PREFIX, create_app
from sooljang.infrastructure.database.session import get_supported_revisions


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), raise_server_exceptions=False)


async def _connected() -> bool:
    return True


async def _disconnected() -> bool:
    return False


@pytest.mark.parametrize("endpoint", ["health", "health/ready"])
def test_health_accepts_only_the_packaged_schema(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    async def revisions() -> tuple[str, ...]:
        return get_supported_revisions()

    monkeypatch.setattr("sooljang.api.routes.health.check_connection", _connected)
    monkeypatch.setattr("sooljang.api.routes.health.get_migration_revisions", revisions)
    response = client.get(f"{API_PREFIX}/{endpoint}")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["schema_ready"] is True
    assert body["database_connected"] is True
    assert body["migration_revisions"] == list(get_supported_revisions())
    assert body["version"] == __version__
    assert body["environment"] == "test"


@pytest.mark.parametrize("actual", [(), ("0001_enable_pg_trgm",), ("future_unknown",)])
def test_connected_database_with_missing_old_or_future_schema_is_not_ready(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, actual: tuple[str, ...]
) -> None:
    async def revisions() -> tuple[str, ...]:
        return actual

    monkeypatch.setattr("sooljang.api.routes.health.check_connection", _connected)
    monkeypatch.setattr("sooljang.api.routes.health.get_migration_revisions", revisions)
    response = client.get(f"{API_PREFIX}/health")
    assert response.status_code == 503
    assert response.json()["database_connected"] is True
    assert response.json()["schema_ready"] is False


def test_extra_migration_head_is_not_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def revisions() -> tuple[str, ...]:
        return (*get_supported_revisions(), "unrelated_branch")

    monkeypatch.setattr("sooljang.api.routes.health.check_connection", _connected)
    monkeypatch.setattr("sooljang.api.routes.health.get_migration_revisions", revisions)
    response = client.get(f"{API_PREFIX}/health/ready")
    assert response.status_code == 503
    assert response.json()["migration_revision"] is None


def test_health_reports_degraded_when_database_is_unreachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sooljang.api.routes.health.check_connection", _disconnected)
    response = client.get(f"{API_PREFIX}/health")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"
    assert response.json()["database_connected"] is False
    assert response.json()["migration_revision"] is None


def test_liveness_does_not_depend_on_database_or_schema(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def unexpected_database_call() -> bool:
        pytest.fail("liveness must not query the database")

    monkeypatch.setattr("sooljang.api.routes.health.check_connection", unexpected_database_call)
    response = client.get(f"{API_PREFIX}/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


def test_openapi_schema_is_served_under_versioned_prefix(client: TestClient) -> None:
    response = client.get(f"{API_PREFIX}/openapi.json")
    assert response.status_code == 200
    assert f"{API_PREFIX}/health" in response.json()["paths"]
