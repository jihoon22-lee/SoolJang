"""사용자 시간대 기준 "오늘"."""

import datetime

import pytest

from sooljang.clock import local_today
from sooljang.config import get_settings


def test_local_today_follows_configured_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    # 날짜 경계가 26시간 떨어진 두 시간대는 같은 순간에 항상 다른 날짜다.
    monkeypatch.setenv("SOOLJANG_TIMEZONE", "Pacific/Kiritimati")
    get_settings.cache_clear()
    ahead = local_today()
    monkeypatch.setenv("SOOLJANG_TIMEZONE", "Etc/GMT+12")
    get_settings.cache_clear()
    behind = local_today()

    assert ahead - behind in {datetime.timedelta(days=1), datetime.timedelta(days=2)}
