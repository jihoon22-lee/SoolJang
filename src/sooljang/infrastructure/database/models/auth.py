"""인증 모델.

세션은 **서버에 저장**한다. JWT 를 쓰지 않는 이유는 즉시 무효화(로그아웃·기기 분실)가
필요하고, 브라우저 저장소에 토큰을 두면 XSS 노출면이 커지기 때문이다
(`docs/architecture.md` §6, §9.7).

세션 토큰은 원문을 저장하지 않고 해시만 저장한다. DB 가 유출되어도 세션을 재현할 수 없어야
한다. 비밀번호와 같은 원칙이다.
"""

import datetime
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from sooljang.infrastructure.database.base import Base, TimestampMixin, new_uuid, str_enum_column
from sooljang.infrastructure.database.models.auth_enums import UserRole


class User(Base, TimestampMixin):
    """사용자.

    `EntityMixin` 을 쓰지 않는다. 사용자 자신에게 `user_id` 를 두면 자기참조가 되어
    의미가 없다.
    """

    __tablename__ = "app_user"

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Argon2id 해시. 원문 비밀번호는 저장하지 않는다.
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(
        str_enum_column(UserRole, "user_role"), nullable=False, default=UserRole.OWNER
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_login_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )

    sessions: Mapped[list[Session]] = relationship(
        "Session", back_populates="user", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # 이메일은 소문자로 정규화해 저장한다. 대소문자만 다른 계정이 생기면 로그인이 혼란스럽다.
        Index(
            "uq_app_user_email",
            "email",
            unique=True,
            postgresql_where="deleted_at IS NULL",
        ),
    )

    def __repr__(self) -> str:
        return f"<User {self.email!r} role={self.role}>"


class Session(Base, TimestampMixin):
    """로그인 세션.

    토큰 원문 대신 SHA-256 해시를 저장한다. 세션 토큰은 비밀번호와 같은 등급의 비밀이므로
    DB 유출 시 그대로 쓸 수 있어서는 안 된다.
    """

    __tablename__ = "app_session"

    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True, default=new_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False
    )
    #: 세션 토큰의 SHA-256 16진 해시.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: 마지막 사용 시각. 유휴 만료 판정과 감사에 쓴다.
    last_seen_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    user_agent: Mapped[str | None] = mapped_column(String(400), default=None)
    ip_address: Mapped[str | None] = mapped_column(String(64), default=None)

    user: Mapped[User] = relationship("User", back_populates="sessions")

    __table_args__ = (
        Index("uq_app_session_token_hash", "token_hash", unique=True),
        Index("ix_app_session_user_id_expires_at", "user_id", "expires_at"),
    )

    @property
    def is_usable(self) -> bool:
        """만료·폐기되지 않은 세션인지."""
        if self.revoked_at is not None or self.deleted_at is not None:
            return False
        return self.expires_at > datetime.datetime.now(datetime.UTC)

    def __repr__(self) -> str:
        return f"<Session user={self.user_id} expires={self.expires_at.isoformat()}>"
