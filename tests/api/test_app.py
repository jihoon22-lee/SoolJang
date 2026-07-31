"""애플리케이션 팩토리와 진입점 테스트."""

from typing import Any

import pytest

from sooljang.api import __main__ as entrypoint
from sooljang.api.app import API_PREFIX, create_app
from sooljang.config import Settings, get_settings


def test_app_exposes_versioned_openapi_paths() -> None:
    app = create_app()

    assert app.openapi_url == f"{API_PREFIX}/openapi.json"
    assert app.docs_url == f"{API_PREFIX}/docs"
    # ReDoc 은 쓰지 않는다. 노출면을 줄인다.
    assert app.redoc_url is None


def test_app_omits_cors_middleware_when_no_origins_configured() -> None:
    app = create_app()

    assert not any("CORSMiddleware" in str(item.cls) for item in app.user_middleware)


def test_app_adds_cors_middleware_when_origins_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOOLJANG_CORS_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()

    app = create_app()

    assert any("CORSMiddleware" in str(item.cls) for item in app.user_middleware)


def test_create_app_accepts_injected_settings(settings: Settings) -> None:
    assert create_app(settings) is not None


def test_main_starts_uvicorn_with_configured_host_and_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOOLJANG_API_HOST", "0.0.0.0")  # noqa: S104 - 테스트 값
    monkeypatch.setenv("SOOLJANG_API_PORT", "9001")
    monkeypatch.setenv("SOOLJANG_ENVIRONMENT", "production")
    get_settings.cache_clear()

    captured: dict[str, Any] = {}

    def _fake_run(target: str, **kwargs: Any) -> None:
        captured["target"] = target
        captured.update(kwargs)

    monkeypatch.setattr(entrypoint.uvicorn, "run", _fake_run)
    entrypoint.main()

    assert captured["target"] == "sooljang.api.app:create_app"
    assert captured["factory"] is True
    assert captured["host"] == "0.0.0.0"  # noqa: S104 - 테스트 값
    assert captured["port"] == 9001
    # 운영에서는 reload 를 켜지 않는다.
    assert captured["reload"] is False
