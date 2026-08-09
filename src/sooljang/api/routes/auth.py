"""인증 라우터.

세션 토큰은 `httpOnly` 쿠키로만 전달한다. 본문이나 로컬 저장소에 두면 XSS 로 탈취될 수 있다.
CSRF 는 double-submit cookie 방식이다. 쿠키와 헤더에 같은 값을 실어 비교한다.
"""

import datetime
from typing import Annotated

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import func, select

from sooljang.api.deps import SessionDep, current_session
from sooljang.api.errors import ConflictError, DomainError, ValidationFailedError
from sooljang.api.schemas.auth import (
    LoginRequest,
    LoginResponse,
    PasswordChangeRequest,
    ProfileUpdateRequest,
    SetupRequest,
    SetupStatus,
    UserOut,
)
from sooljang.application.auth import (
    AuthError,
    RateLimitedError,
    WeakPasswordError,
    authenticate,
    create_user,
    hash_password,
    issue_session,
    revoke_all_sessions,
    revoke_session,
    verify_password,
)
from sooljang.infrastructure.database.models import Session, User

router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_COOKIE = "sooljang_session"
CSRF_COOKIE = "sooljang_csrf"
CSRF_HEADER = "X-CSRF-Token"


class UnauthorizedError(DomainError):
    status_code = status.HTTP_401_UNAUTHORIZED
    error_type = "unauthorized"
    title = "인증이 필요합니다"


class TooManyRequestsError(DomainError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    error_type = "rate-limited"
    title = "요청이 너무 많습니다"


def _client_ip(request: Request) -> str | None:
    """클라이언트 IP.

    Tailscale 뒤의 리버스 프록시를 거치므로 `X-Forwarded-For` 를 우선한다. 신뢰할 수 있는
    프록시가 앞에 있다는 전제이며, 인터넷에 직접 노출하지 않는다는 배포 조건에 기반한다.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


def _set_auth_cookies(
    response: Response, *, token: str, csrf_token: str, expires_at: datetime.datetime, secure: bool
) -> None:
    max_age = int((expires_at - datetime.datetime.now(datetime.UTC)).total_seconds())
    # 세션 토큰은 httpOnly 다. JavaScript 가 읽을 수 없어야 XSS 로 탈취되지 않는다.
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    # CSRF 토큰은 JavaScript 가 읽어 헤더에 실어야 하므로 httpOnly 가 아니다.
    # 공격자가 이 값을 읽으려면 이미 XSS 가 성립한 상태이므로 CSRF 방어의 전제와 무관하다.
    response.set_cookie(
        CSRF_COOKIE,
        csrf_token,
        max_age=max_age,
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


@router.get("/setup", response_model=SetupStatus, summary="초기 설정 필요 여부")
async def setup_status(session: SessionDep) -> SetupStatus:
    """사용자가 하나도 없으면 최초 계정을 만들어야 한다.

    인증 없이 접근할 수 있어야 로그인 화면이 어떤 폼을 보여줄지 결정할 수 있다. 사용자 수만
    알려주므로 노출되는 정보가 없다.
    """
    count = await session.scalar(
        select(func.count()).select_from(User).where(User.deleted_at.is_(None))
    )
    return SetupStatus(needs_setup=(count or 0) == 0)


@router.post(
    "/setup",
    response_model=LoginResponse,
    status_code=status.HTTP_201_CREATED,
    summary="최초 사용자 생성",
)
async def setup(
    payload: SetupRequest, request: Request, response: Response, session: SessionDep
) -> LoginResponse:
    """최초 사용자를 만들고 바로 로그인시킨다.

    **사용자가 하나도 없을 때만 허용한다.** 그러지 않으면 누구나 계정을 만들 수 있다.
    추가 계정은 로그인한 소유자가 만든다(Task 20 공유 기능).
    """
    count = await session.scalar(
        select(func.count()).select_from(User).where(User.deleted_at.is_(None))
    )
    if (count or 0) > 0:
        raise ConflictError("이미 사용자가 있습니다. 로그인하세요")

    try:
        user = await create_user(
            session,
            email=payload.email,
            password=payload.password,
            display_name=payload.display_name,
        )
    except WeakPasswordError as error:
        raise ValidationFailedError(str(error)) from error

    return await _login_response(request, response, session, user)


@router.post("/login", response_model=LoginResponse, summary="로그인")
async def login(
    payload: LoginRequest, request: Request, response: Response, session: SessionDep
) -> LoginResponse:
    """이메일·비밀번호로 로그인한다.

    사용자가 없는 경우와 비밀번호가 틀린 경우를 같은 메시지로 알린다. 구분하면 어떤 이메일이
    등록되어 있는지 알려주는 셈이다.
    """
    try:
        user = await authenticate(
            session,
            email=payload.email,
            password=payload.password,
            client_ip=_client_ip(request),
        )
    except RateLimitedError as error:
        raise TooManyRequestsError(str(error)) from error
    except AuthError as error:
        raise UnauthorizedError(str(error)) from error

    return await _login_response(request, response, session, user)


async def _login_response(
    request: Request, response: Response, session: SessionDep, user: User
) -> LoginResponse:
    from sooljang.application.auth import generate_csrf_token

    record, token = await issue_session(
        session,
        user=user,
        user_agent=request.headers.get("User-Agent"),
        client_ip=_client_ip(request),
    )
    csrf_token = generate_csrf_token()
    # CSRF 토큰을 세션에 묶는 대신 쿠키·헤더 일치만 확인한다. 쿠키를 심을 수 있는 공격자는
    # 이미 same-site 제약을 넘은 상태이며, 그 경우는 SameSite=Lax 가 1차로 막는다.
    _set_auth_cookies(
        response,
        token=token,
        csrf_token=csrf_token,
        expires_at=record.expires_at,
        secure=_use_secure_cookie(request),
    )
    return LoginResponse(
        user=UserOut.model_validate(user),
        csrf_token=csrf_token,
        expires_at=record.expires_at,
    )


def _use_secure_cookie(request: Request) -> bool:
    """`Secure` 플래그 여부.

    HTTPS 로 접속했을 때만 켠다. 로컬 개발은 평문 HTTP 라 항상 켜면 쿠키가 저장되지 않아
    로그인이 안 된다. 운영은 Tailscale HTTPS 를 거치므로 자동으로 켜진다.
    """
    if request.url.scheme == "https":
        return True
    return request.headers.get("X-Forwarded-Proto", "").lower() == "https"


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="로그아웃")
async def logout(request: Request, response: Response, session: SessionDep) -> None:
    """세션을 폐기하고 쿠키를 지운다. 이미 로그아웃된 상태여도 성공한다(멱등)."""
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        await revoke_session(session, token)
    _clear_auth_cookies(response)


@router.get("/me", response_model=UserOut, summary="현재 사용자")
async def me(active_session: Annotated[Session, current_session], session: SessionDep) -> UserOut:
    user = await session.get(User, active_session.user_id)
    if user is None:
        raise UnauthorizedError("사용자를 찾을 수 없습니다")
    return UserOut.model_validate(user)


@router.patch("/me", response_model=UserOut, summary="표시 이름 수정")
async def update_profile(
    payload: ProfileUpdateRequest,
    active_session: Annotated[Session, current_session],
    session: SessionDep,
) -> UserOut:
    """로그인한 사용자의 표시 이름을 바꾼다.

    이메일 변경은 재인증·중복 검사가 얽혀 범위 밖이고, 비밀번호는 `/password` 가 따로
    있다 — 이 엔드포인트는 화면 헤더 등에 노출되는 이름만 다룬다.
    """
    user = await session.get(User, active_session.user_id)
    if user is None:
        raise UnauthorizedError("사용자를 찾을 수 없습니다")
    display_name = payload.display_name.strip()
    if not display_name:
        raise ValidationFailedError("표시 이름을 입력하세요")
    user.display_name = display_name
    await session.flush()
    return UserOut.model_validate(user)


@router.post(
    "/password",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="비밀번호 변경 (다른 세션 전부 폐기)",
)
async def change_password(
    payload: PasswordChangeRequest,
    active_session: Annotated[Session, current_session],
    session: SessionDep,
) -> None:
    """비밀번호를 바꾸고 **다른 모든 세션을 폐기한다.**

    비밀번호를 바꾸는 이유는 대개 유출 우려다. 기존 세션을 살려 두면 바꾼 의미가 없다.
    현재 세션은 유지해 사용자가 다시 로그인하지 않게 한다.
    """
    user = await session.get(User, active_session.user_id)
    if user is None:
        raise UnauthorizedError("사용자를 찾을 수 없습니다")
    if not verify_password(payload.current_password, user.password_hash):
        raise UnauthorizedError("현재 비밀번호가 올바르지 않습니다")

    try:
        user.password_hash = hash_password(payload.new_password)
    except WeakPasswordError as error:
        raise ValidationFailedError(str(error)) from error

    await revoke_all_sessions(session, user.id)
    # 현재 세션은 되살려 사용자가 즉시 로그아웃되지 않게 한다.
    active_session.revoked_at = None
    await session.flush()
