"""RFC 9457 Problem Details 에러 응답.

에러 형식을 한 곳에서 정하면 클라이언트가 분기 로직을 한 번만 쓴다. FastAPI 기본
`{"detail": ...}` 는 필드별 오류를 표현하기 어렵고 타입 식별자가 없다.
"""

import logging
from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

#: 에러 타입 URI 접두사. 문서 페이지로 연결할 수 있게 안정적인 식별자를 유지한다.
ERROR_TYPE_BASE = "https://sooljang.local/errors"

PROBLEM_CONTENT_TYPE = "application/problem+json"

logger = logging.getLogger(__name__)


class FieldError(BaseModel):
    """필드 단위 오류. 폼 화면이 어느 입력에 표시할지 알 수 있어야 한다."""

    field: str
    code: str
    message: str


class ProblemDetail(BaseModel):
    """RFC 9457 Problem Details."""

    type: str = Field(description="에러 종류 식별자 URI")
    title: str = Field(description="사람이 읽는 요약")
    status: int
    detail: str | None = None
    instance: str | None = Field(default=None, description="문제가 발생한 요청 경로")
    errors: list[FieldError] = Field(default_factory=list)


class DomainError(Exception):
    """도메인 규칙 위반. 라우터가 이를 Problem Details 로 변환한다."""

    status_code = status.HTTP_400_BAD_REQUEST
    error_type = "domain"
    title = "요청을 처리할 수 없습니다"

    def __init__(self, detail: str, *, errors: list[FieldError] | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.errors = errors or []


class NotFoundError(DomainError):
    status_code = status.HTTP_404_NOT_FOUND
    error_type = "not-found"
    title = "대상을 찾을 수 없습니다"


class ConflictError(DomainError):
    status_code = status.HTTP_409_CONFLICT
    error_type = "conflict"
    title = "현재 상태와 충돌합니다"


class ValidationFailedError(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    error_type = "validation"
    title = "요청 값이 올바르지 않습니다"


class LlmNotConfiguredError(DomainError):
    """라벨 OCR(Task 17) 등 LLM 이 필요한 기능인데 설정이 없을 때.

    일반 `ValidationFailedError` 와 구분하는 이유는, 프론트엔드가 이 경우에만 "설정으로
    이동" 버튼을 보여줘야 하기 때문이다 — 별도 `error_type` 이 있어야 분기할 수 있다.
    """

    status_code = status.HTTP_409_CONFLICT
    error_type = "llm-not-configured"
    title = "LLM 설정이 필요합니다"


def problem_response(
    *,
    status_code: int,
    error_type: str,
    title: str,
    detail: str | None = None,
    instance: str | None = None,
    errors: list[FieldError] | None = None,
) -> JSONResponse:
    """Problem Details 응답을 만든다."""
    payload = ProblemDetail(
        type=f"{ERROR_TYPE_BASE}/{error_type}",
        title=title,
        status=status_code,
        detail=detail,
        instance=instance,
        errors=errors or [],
    )
    return JSONResponse(
        status_code=status_code,
        content=payload.model_dump(mode="json"),
        media_type=PROBLEM_CONTENT_TYPE,
    )


def _http_status_title(status_code: int) -> str:
    return {
        status.HTTP_400_BAD_REQUEST: "잘못된 요청입니다",
        status.HTTP_401_UNAUTHORIZED: "인증이 필요합니다",
        status.HTTP_403_FORBIDDEN: "권한이 없습니다",
        status.HTTP_404_NOT_FOUND: "대상을 찾을 수 없습니다",
        status.HTTP_409_CONFLICT: "현재 상태와 충돌합니다",
        status.HTTP_429_TOO_MANY_REQUESTS: "요청이 너무 많습니다",
    }.get(status_code, "요청을 처리할 수 없습니다")


def register_error_handlers(app: FastAPI, *, cors_origins: Sequence[str] = ()) -> None:
    """모든 에러를 Problem Details 로 통일한다.

    `cors_origins` 는 `Exception` 캐치올 핸들러에만 쓰인다 — FastAPI/Starlette 의
    `Exception` 핸들러는 `ServerErrorMiddleware` 에서 실행되는데, 이 미들웨어는
    `CORSMiddleware` 보다 바깥(더 먼저 요청을 받고, 더 나중에 응답을 내보내는 계층)에
    있어 평소 CORS 헤더가 안 붙는다. 개발 환경처럼 프론트(5173)와 API(8000)가 다른
    origin 이면, 브라우저가 이 500 응답을 CORS 오류로 가려 버려 실제 에러 메시지를
    볼 수 없다. 운영은 단일 리버스 프록시라 origin 이 같아 원래도 문제가 없다.
    """

    def _cors_headers(request: Request) -> dict[str, str]:
        origin = request.headers.get("origin")
        if origin and origin in cors_origins:
            return {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true",
                "Vary": "Origin",
            }
        return {}

    @app.exception_handler(DomainError)
    async def _domain_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, DomainError)
        return problem_response(
            status_code=exc.status_code,
            error_type=exc.error_type,
            title=exc.title,
            detail=exc.detail,
            instance=str(request.url.path),
            errors=exc.errors,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, RequestValidationError)
        errors = [
            FieldError(
                field=".".join(str(part) for part in error["loc"][1:]) or "body",
                code=str(error["type"]),
                message=str(error["msg"]),
            )
            for error in exc.errors()
        ]
        return problem_response(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            error_type="validation",
            title="요청 값이 올바르지 않습니다",
            detail="입력값을 확인하세요",
            instance=str(request.url.path),
            errors=errors,
        )

    @app.exception_handler(IntegrityError)
    async def _integrity_error(request: Request, exc: Exception) -> JSONResponse:
        # DB 제약 위반은 대부분 중복이다. 원문을 그대로 노출하면 스키마 정보가 새므로
        # 종류만 알린다.
        return problem_response(
            status_code=status.HTTP_409_CONFLICT,
            error_type="conflict",
            title="현재 상태와 충돌합니다",
            detail="이미 존재하는 값이거나 제약 조건을 위반했습니다",
            instance=str(request.url.path),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, StarletteHTTPException)
        detail: Any = exc.detail
        return problem_response(
            status_code=exc.status_code,
            error_type=f"http-{exc.status_code}",
            title=_http_status_title(exc.status_code),
            detail=detail if isinstance(detail, str) else None,
            instance=str(request.url.path),
        )

    @app.exception_handler(Exception)
    async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        # DB 접속 끊김처럼 위 핸들러 어디에도 안 걸리는 예외를 위한 마지막 그물이다. 이게
        # 없으면 Starlette 기본 처리로 떨어져 이 API 만 유일하게 일반 텍스트 500 을
        # 돌려주고, "모든 에러를 Problem Details 로 통일한다"는 이 함수의 전제가 깨진다
        # (Task 21 장애 주입 검증에서 발견). 원인 메시지는 스택/쿼리를 노출할 수 있어
        # 응답에는 담지 않는다 — 서버 로그에는 남긴다.
        logger.exception("처리되지 않은 예외", exc_info=exc)
        response = problem_response(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            error_type="internal",
            title="예기치 않은 오류가 발생했습니다",
            detail="잠시 후 다시 시도하세요. 문제가 이어지면 관리자에게 문의하세요",
            instance=str(request.url.path),
        )
        response.headers.update(_cors_headers(request))
        return response
