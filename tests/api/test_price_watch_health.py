"""DB/schema가 정상이더라도 worker의 종료·오류·stale heartbeat는 ready가 아니다."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from sooljang.api.app import API_PREFIX, create_app
from sooljang.api.routes import health


@pytest.mark.parametrize(
    ("state", "age", "done", "ready"),
    [
        ("disabled", None, False, True),
        ("running", 0, False, True),
        ("starting", None, False, False),
        ("error", 0, False, False),
        ("running", 121, False, False),
        ("running", 0, True, False),
        ("running", None, False, False),
    ],
)
def test_worker_health_requires_live_task_and_fresh_completed_tick(
    monkeypatch: pytest.MonkeyPatch,
    state: str,
    age: int | None,
    done: bool,
    ready: bool,
) -> None:
    monkeypatch.setattr(health, "check_connection", AsyncMock(return_value=True))
    monkeypatch.setattr(health, "get_migration_revisions", AsyncMock(return_value=("supported",)))
    monkeypatch.setattr(health, "get_supported_revisions", lambda: ("supported",))
    app = create_app()
    with TestClient(app) as client:
        app.state.price_watch_worker = {
            "state": state,
            "last_tick_at": (datetime.now(UTC) - timedelta(seconds=age)).isoformat()
            if age is not None
            else None,
        }
        app.state.price_watch_task = SimpleNamespace(done=lambda: done)
        response = client.get(f"{API_PREFIX}/health/ready")
        assert response.status_code == (200 if ready else 503)
        assert response.json()["price_watch_worker_ready"] is ready
        assert response.json()["schema_ready"] is True
