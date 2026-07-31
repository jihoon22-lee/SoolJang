"""Alembic 마이그레이션 환경.

접속 URL 은 `alembic.ini` 가 아니라 애플리케이션 설정에서 읽는다. 두 곳에 URL 이
있으면 반드시 어긋난다.

마이그레이션은 동기 드라이버로 실행한다. Alembic 의 동기 실행 경로가 단순하고,
DDL 은 커넥션 풀이 필요하지 않다.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from sooljang.config import get_settings
from sooljang.infrastructure.database.base import Base

# 모델을 import 해 Base.metadata 를 채운다. Task 7 에서 모델이 추가되면 여기에 등록한다.
target_metadata = Base.metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)


def _database_url() -> str:
    """비동기 URL 을 동기 드라이버 URL 로 바꾼다."""
    url = str(get_settings().database_url)
    return url.replace("+asyncpg", "+psycopg").replace(
        "postgresql+psycopg_async", "postgresql+psycopg"
    )


def run_migrations_offline() -> None:
    """SQL 스크립트만 생성한다 (`--sql`)."""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """실제 데이터베이스에 적용한다."""
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _database_url()

    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
