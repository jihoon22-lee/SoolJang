"""인증 API 스키마."""

import datetime
import uuid

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from sooljang.application.auth import MIN_PASSWORD_LENGTH
from sooljang.infrastructure.database.models import UserRole


class LoginRequest(BaseModel):
    """로그인 요청."""

    email: EmailStr
    password: str = Field(min_length=1, description="비밀번호")


class UserOut(BaseModel):
    """현재 사용자."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str
    role: UserRole
    last_login_at: datetime.datetime | None = None


class LoginResponse(BaseModel):
    """로그인 응답.

    세션 토큰은 본문에 넣지 않는다. `httpOnly` 쿠키로만 전달해 JavaScript 가 읽을 수 없게
    한다. CSRF 토큰은 쿠키와 헤더 양쪽에 실어야 하므로 본문에도 담는다.
    """

    user: UserOut
    csrf_token: str = Field(description="쓰기 요청의 X-CSRF-Token 헤더에 실어 보낸다")
    expires_at: datetime.datetime


class SetupRequest(BaseModel):
    """최초 사용자 생성 요청.

    사용자가 하나도 없을 때만 허용한다. 그러지 않으면 누구나 계정을 만들 수 있다.
    """

    email: EmailStr
    password: str = Field(
        min_length=MIN_PASSWORD_LENGTH,
        description=f"{MIN_PASSWORD_LENGTH}자 이상",
    )
    display_name: str = Field(min_length=1, max_length=120)


class SetupStatus(BaseModel):
    """초기 설정 필요 여부. 로그인 화면이 어떤 폼을 보여줄지 결정한다."""

    needs_setup: bool = Field(description="true 면 최초 사용자를 만들어야 한다")


class PasswordChangeRequest(BaseModel):
    """비밀번호 변경."""

    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH)


class ProfileUpdateRequest(BaseModel):
    """표시 이름 변경. 이메일·비밀번호는 여기서 다루지 않는다."""

    display_name: str = Field(min_length=1, max_length=120)
