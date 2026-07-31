"""FastAPI 애플리케이션 팩토리."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sooljang import __version__
from sooljang.api.routes import health
from sooljang.config import Settings, get_settings

API_PREFIX = "/api/v1"


def create_app(settings: Settings | None = None) -> FastAPI:
    """애플리케이션을 조립한다. 테스트가 설정을 주입할 수 있도록 인자를 받는다."""
    settings = settings or get_settings()

    app = FastAPI(
        title="술장 (SoolJang) API",
        description="개인 주류 컬렉션 기록·관리·분석 API",
        version=__version__,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )

    if settings.cors_origins:
        # 운영에서는 단일 리버스 프록시로 같은 origin 을 쓰므로 비어 있다.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(health.router, prefix=API_PREFIX)
    return app
