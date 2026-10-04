"""사용자 기준 날짜.

서버 프로세스의 시간대(컨테이너는 UTC)와 사용자가 사는 시간대가 다르다. 밤늦게 마신
기록이 전날로 저장되지 않도록 "오늘"은 항상 설정된 사용자 시간대로 계산한다.
"""

import datetime
from zoneinfo import ZoneInfo

from sooljang.config import get_settings


def local_today() -> datetime.date:
    """설정한 시간대(`SOOLJANG_TIMEZONE`, 기본 Asia/Seoul)의 오늘 날짜."""
    return datetime.datetime.now(ZoneInfo(get_settings().timezone)).date()
