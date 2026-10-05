"""설정 로딩 테스트."""

import pytest
from pydantic import ValidationError

from sooljang.config import Settings, get_settings


def test_settings_read_database_url_from_environment(settings: Settings) -> None:
    assert settings.environment == "test"
    assert str(settings.database_url).startswith("postgresql+psycopg://")


def test_settings_reject_missing_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SOOLJANG_DATABASE_URL", raising=False)
    get_settings.cache_clear()

    # `.env` 를 읽지 않게 해 환경 변수만으로 판정한다.
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_cors_origins_accept_comma_separated_string(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOOLJANG_CORS_ORIGINS", "http://localhost:5173, http://127.0.0.1:5173")
    get_settings.cache_clear()

    assert get_settings().cors_origins == ("http://localhost:5173", "http://127.0.0.1:5173")


def test_cors_origins_default_to_empty(settings: Settings) -> None:
    assert settings.cors_origins == ()


def test_is_production_reflects_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOOLJANG_ENVIRONMENT", "production")
    get_settings.cache_clear()
    assert get_settings().is_production is True

    monkeypatch.setenv("SOOLJANG_ENVIRONMENT", "local")
    get_settings.cache_clear()
    assert get_settings().is_production is False


def test_settings_reject_invalid_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOOLJANG_API_PORT", "0")
    get_settings.cache_clear()

    with pytest.raises(ValidationError):
        get_settings()


def test_settings_reject_invalid_pool_size(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOOLJANG_DATABASE_POOL_SIZE", "0")
    get_settings.cache_clear()

    with pytest.raises(ValidationError):
        get_settings()


def test_unknown_timezone_is_rejected_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    # 오타 난 시간대로 기동하면 날짜를 비운 기록마다 500 이 난다. 설정 단계에서 막는다.
    monkeypatch.setenv("SOOLJANG_TIMEZONE", "Asia/Seol")
    get_settings.cache_clear()

    with pytest.raises(ValidationError, match="알 수 없는 시간대"):
        Settings(_env_file=None)


def test_valid_timezone_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOOLJANG_TIMEZONE", "Europe/Paris")
    get_settings.cache_clear()

    assert Settings(_env_file=None).timezone == "Europe/Paris"
