"""데이터베이스 엔진과 세션 관리.

엔진은 프로세스당 하나만 만든다. 요청마다 엔진을 만들면 커넥션 풀이 무의미해진다.
"""

from collections.abc import AsyncGenerator
from functools import lru_cache
from pathlib import Path

from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from sooljang.config import Settings, get_settings


@lru_cache
def get_engine() -> AsyncEngine:
    """프로세스 전역 비동기 엔진."""
    settings: Settings = get_settings()
    return create_async_engine(
        str(settings.database_url),
        echo=settings.database_echo,
        pool_size=settings.database_pool_size,
        pool_pre_ping=True,
    )


@lru_cache
def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """세션 팩토리. `expire_on_commit=False` 로 커밋 후에도 객체를 읽을 수 있게 한다."""
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession]:
    """FastAPI 의존성으로 쓰는 요청 범위 세션."""
    async with get_session_factory()() as session:
        yield session


async def check_connection() -> bool:
    """DB 연결 가능 여부. 헬스체크에서 사용한다."""
    try:
        async with get_engine().connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 - 헬스체크는 원인을 구분하지 않고 실패로 보고한다
        return False
    return True


async def get_migration_revision() -> str | None:
    """현재 적용된 Alembic 리비전. 배포 버전과 스키마 버전의 불일치를 조기에 드러낸다."""
    try:
        async with get_engine().connect() as connection:
            result = await connection.execute(text("SELECT version_num FROM alembic_version"))
            row = result.first()
    except Exception:  # noqa: BLE001 - 테이블이 아직 없을 수 있다
        return None
    return None if row is None else str(row[0])


@lru_cache
def get_supported_revisions() -> tuple[str, ...]:
    """설치된 앱에 포함된 migration head. 작업 디렉터리나 운영 설정에 의존하지 않는다."""
    scripts = ScriptDirectory(str(Path(__file__).with_name("migrations")))
    return tuple(sorted(scripts.get_heads()))


async def get_migration_revisions() -> tuple[str, ...]:
    """복수 head를 포함한 실제 리비전. 누락·조회 실패는 준비되지 않은 상태다."""
    try:
        async with get_engine().connect() as connection:
            result = await connection.execute(text("SELECT version_num FROM alembic_version"))
            return tuple(sorted(str(row[0]) for row in result.all()))
    except Exception:  # noqa: BLE001 - readiness 응답에 연결 정보나 SQL을 노출하지 않는다
        return ()


def reset_database_state() -> None:
    """캐시된 엔진·세션 팩토리를 폐기한다. 테스트에서 설정을 바꿀 때 사용한다."""
    get_engine.cache_clear()
    get_session_factory.cache_clear()
