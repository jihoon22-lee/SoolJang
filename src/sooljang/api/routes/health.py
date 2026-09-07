"""헬스체크 라우터.

공개 운영 엔드포인트다. 프로세스 생존과 DB·스키마 준비 상태를 분리한다.
"""

from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from sooljang import __version__
from sooljang.config import get_settings
from sooljang.infrastructure.database.session import (
    check_connection,
    get_migration_revisions,
    get_supported_revisions,
)

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """헬스체크 응답."""

    status: Literal["ok", "degraded"]
    version: str
    environment: str
    database_connected: bool
    migration_revision: str | None
    schema_ready: bool
    supported_revisions: tuple[str, ...]
    migration_revisions: tuple[str, ...]


class LivenessResponse(BaseModel):
    """DB와 무관한 프로세스 생존 상태."""

    status: Literal["ok"] = "ok"
    version: str = __version__


@router.get("/health/live", response_model=LivenessResponse, summary="프로세스 생존 확인")
async def liveness() -> LivenessResponse:
    return LivenessResponse()


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="서비스 상태 확인",
    responses={503: {"description": "의존 구성 요소에 문제가 있음"}},
)
@router.get(
    "/health/ready",
    response_model=HealthResponse,
    summary="서비스 준비 상태 확인",
    responses={503: {"description": "DB 또는 스키마가 준비되지 않음"}},
)
async def health(response: Response) -> HealthResponse:
    """서비스와 의존 구성 요소의 상태를 보고한다."""
    connected = await check_connection()
    revisions = await get_migration_revisions() if connected else ()
    supported = get_supported_revisions()
    schema_ready = bool(supported) and revisions == supported
    ready = connected and schema_ready

    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return HealthResponse(
        status="ok" if ready else "degraded",
        version=__version__,
        environment=get_settings().environment,
        database_connected=connected,
        migration_revision=revisions[0] if len(revisions) == 1 else None,
        schema_ready=schema_ready,
        supported_revisions=supported,
        migration_revisions=revisions,
    )
