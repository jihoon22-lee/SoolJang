"""FastAPI 애플리케이션 팩토리."""

from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sooljang import __version__
from sooljang.api.errors import ProblemDetail, register_error_handlers
from sooljang.api.routes import categories, health, legacy_import, products, purchases
from sooljang.config import Settings, get_settings

API_PREFIX = "/api/v1"

#: 모든 엔드포인트 공통 에러 응답. OpenAPI 에 한 번만 기술한다.
_COMMON_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ProblemDetail, "description": "잘못된 요청"},
    404: {"model": ProblemDetail, "description": "대상을 찾을 수 없음"},
    409: {"model": ProblemDetail, "description": "현재 상태와 충돌"},
    422: {"model": ProblemDetail, "description": "요청 값 검증 실패"},
}


def create_app(settings: Settings | None = None) -> FastAPI:
    """애플리케이션을 조립한다. 테스트가 설정을 주입할 수 있도록 인자를 받는다."""
    settings = settings or get_settings()

    app = FastAPI(
        title="술장 (SoolJang) API",
        description=(
            "개인 주류 컬렉션 기록·관리·분석 API.\n\n"
            "에러는 RFC 9457 Problem Details 형식이다. 파생 지표는 저장하지 않고 매번 "
            "계산하며, 금액이 `null` 인 것은 0원이 아니라 가격 정보가 없다는 뜻이다."
        ),
        version=__version__,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        responses=_COMMON_RESPONSES,
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

    register_error_handlers(app)

    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(categories.router, prefix=API_PREFIX)
    app.include_router(products.router, prefix=API_PREFIX)
    app.include_router(purchases.vendors_router, prefix=API_PREFIX)
    app.include_router(purchases.purchases_router, prefix=API_PREFIX)
    app.include_router(legacy_import.router, prefix=API_PREFIX)
    return app
