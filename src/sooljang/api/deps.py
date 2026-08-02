"""FastAPI 의존성.

`current_user_id` 가 **세션 쿠키 기반**으로 동작한다(Task 12). Task 9 에서 이 자리를 미리
둔 덕분에 이 함수만 바꾸면 모든 라우터가 자동으로 실제 사용자를 쓴다.

인증을 각 라우터에 개별로 붙이지 않는 이유는, 새 라우터를 추가할 때 인증을 빠뜨리면 조용히
공개 엔드포인트가 되기 때문이다. `app.py` 에서 라우터 단위로 의존성을 걸어 **기본이 인증**
이 되게 한다.
"""

import uuid
from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import DomainError
from sooljang.config import Settings, get_settings
from sooljang.infrastructure.database.models import Session
from sooljang.infrastructure.database.session import get_session_factory

#: 쓰기 메서드. CSRF 검사는 이 메서드에만 적용한다.
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class UnauthenticatedError(DomainError):
    status_code = status.HTTP_401_UNAUTHORIZED
    error_type = "unauthorized"
    title = "인증이 필요합니다"


class CsrfError(DomainError):
    status_code = status.HTTP_403_FORBIDDEN
    error_type = "csrf-mismatch"
    title = "CSRF 토큰이 일치하지 않습니다"


async def db_session() -> AsyncGenerator[AsyncSession]:
    """요청 범위 세션. 예외가 나면 롤백하고, 정상 종료 시 커밋한다."""
    async with get_session_factory()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


def settings_dependency() -> Settings:
    return get_settings()


SessionDep = Annotated[AsyncSession, Depends(db_session)]
SettingsDep = Annotated[Settings, Depends(settings_dependency)]


async def active_session(request: Request, session: SessionDep) -> Session:
    """세션 쿠키를 검증해 활성 세션을 반환한다.

    쓰기 요청은 CSRF 토큰도 확인한다. `SameSite=Lax` 가 1차 방어이고 double-submit cookie
    가 2차다. 브라우저가 `SameSite` 를 무시하는 경우와 최상위 내비게이션 POST 를 대비한다.
    """
    # 라우터 안에서 이미 해석했다면 재사용한다. 한 요청에서 두 번 조회하지 않는다.
    cached = getattr(request.state, "auth_session", None)
    if isinstance(cached, Session):
        return cached

    from sooljang.api.routes.auth import CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE
    from sooljang.application.auth import csrf_tokens_match, resolve_session

    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise UnauthenticatedError("로그인이 필요합니다")

    record = await resolve_session(session, token)
    if record is None:
        raise UnauthenticatedError("세션이 만료되었습니다. 다시 로그인하세요")

    if request.method in UNSAFE_METHODS and not csrf_tokens_match(
        request.cookies.get(CSRF_COOKIE), request.headers.get(CSRF_HEADER)
    ):
        raise CsrfError("CSRF 토큰이 없거나 일치하지 않습니다")

    request.state.auth_session = record
    return record


async def current_user_id(session_record: Annotated[Session, Depends(active_session)]) -> uuid.UUID:
    """현재 사용자 식별자. 세션 쿠키에서 해석한다."""
    return session_record.user_id


current_session = Depends(active_session)

UserDep = Annotated[uuid.UUID, Depends(current_user_id)]
