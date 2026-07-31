"""헬스체크 라우터.

인증을 요구하지 않는 유일한 엔드포인트다. DB 연결과 마이그레이션 리비전을 함께
보고해, 애플리케이션은 살아 있지만 스키마가 어긋난 상태를 구분할 수 있게 한다.
"""

from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from sooljang import __version__
from sooljang.config import get_settings
from sooljang.infrastructure.database.session import check_connection, get_migration_revision

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """헬스체크 응답."""

    status: Literal["ok", "degraded"]
    version: str
    environment: str
    database_connected: bool
    migration_revision: str | None


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="서비스 상태 확인",
    responses={503: {"description": "의존 구성 요소에 문제가 있음"}},
)
async def health(response: Response) -> HealthResponse:
    """서비스와 의존 구성 요소의 상태를 보고한다."""
    connected = await check_connection()
    revision = await get_migration_revision() if connected else None

    if not connected:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return HealthResponse(
        status="ok" if connected else "degraded",
        version=__version__,
        environment=get_settings().environment,
        database_connected=connected,
        migration_revision=revision,
    )
