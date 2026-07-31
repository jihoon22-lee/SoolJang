"""애플리케이션 설정.

값은 환경 변수 또는 `.env` 로만 주입한다. 시크릿에 기본값을 두지 않는다. 기본값이
있으면 설정을 잊은 채로 배포되어도 동작해 버려서, 잘못된 구성이 조용히 통과한다.
"""

import os
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, PostgresDsn, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """환경 변수로 주입되는 애플리케이션 설정."""

    model_config = SettingsConfigDict(
        env_prefix="SOOLJANG_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["local", "test", "production"] = "local"
    debug: bool = False

    database_url: PostgresDsn = Field(
        description="SQLAlchemy 접속 URL. 예: postgresql+psycopg://user:pw@host:5432/db",
    )
    database_pool_size: int = Field(default=5, ge=1, le=50)
    database_echo: bool = False

    api_host: str = "127.0.0.1"
    api_port: int = Field(default=8000, ge=1, le=65535)

    # 프론트엔드 개발 서버 origin. 운영에서는 단일 프록시를 쓰므로 비워 둔다.
    # NoDecode 로 pydantic-settings 의 JSON 디코딩을 끄고, 쉼표 구분 문자열을 받는다.
    # 환경 변수로 리스트를 표현할 때 JSON 을 요구하면 실수하기 쉽다.
    cors_origins: Annotated[tuple[str, ...], NoDecode] = ()

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        """쉼표로 구분한 문자열도 허용한다. 환경 변수는 리스트를 표현하기 어렵다."""
        if isinstance(value, str):
            return tuple(item.strip() for item in value.split(",") if item.strip())
        return value

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    """설정을 한 번만 읽어 캐시한다. 테스트는 `get_settings.cache_clear()` 로 초기화한다.

    읽을 `.env` 경로는 `SOOLJANG_ENV_FILE` 로 바꿀 수 있다. 빈 문자열이면 파일을 읽지
    않는다. 테스트가 개발자의 로컬 `.env` 에 따라 통과·실패하는 것을 막기 위한 장치다.
    """
    env_file = os.environ.get("SOOLJANG_ENV_FILE", ".env")
    return Settings(_env_file=env_file or None)
