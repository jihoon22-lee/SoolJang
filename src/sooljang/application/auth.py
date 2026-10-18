"""인증 서비스.

비밀번호는 Argon2id 로 해시한다. 세션 토큰은 원문을 저장하지 않고 SHA-256 해시만 저장해,
DB 가 유출되어도 세션을 재현할 수 없게 한다.

레이트 리밋은 인메모리다. 단일 사용자·단일 프로세스 전제이며, 여러 워커로 늘리면 Redis 등
공유 저장소가 필요해진다. 그 시점의 판단으로 남긴다.
"""

import asyncio
import datetime
import hashlib
import hmac
import ipaddress
import secrets
import time
import uuid
from dataclasses import dataclass, field

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import Session, User, UserRole

#: 세션 유효 기간. 개인 도구라 자주 로그인하게 만들 이유가 없다.
SESSION_LIFETIME = datetime.timedelta(days=30)
#: 세션 토큰 바이트 수. 32바이트(256비트)면 추측 공격이 무의미하다.
TOKEN_BYTES = 32
#: 비밀번호 최소 길이. 개인 도구지만 Tailscale 밖으로 나갈 수 있으므로 하한을 둔다.
MIN_PASSWORD_LENGTH = 10

_hasher = PasswordHasher()


class AuthError(Exception):
    """인증 실패. 라우터가 401 로 변환한다."""


class RateLimitedError(AuthError):
    """로그인 시도가 너무 많다."""

    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__(f"로그인 시도가 너무 많습니다. {retry_after_seconds}초 후 다시 시도하세요")
        self.retry_after_seconds = retry_after_seconds


class WeakPasswordError(ValueError):
    """비밀번호가 정책을 만족하지 않는다."""


def hash_password(password: str) -> str:
    """비밀번호를 Argon2id 로 해시한다."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise WeakPasswordError(f"비밀번호는 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다")
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """비밀번호를 검증한다. 해시 형식이 깨져 있어도 예외 대신 False 를 반환한다."""
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError, InvalidHashError, ValueError:
        return False


def needs_rehash(password_hash: str) -> bool:
    """Argon2 파라미터가 바뀌었을 때 재해시가 필요한지."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError, ValueError:
        return False


def generate_session_token() -> str:
    """URL 에 실을 수 있는 세션 토큰."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """세션 토큰의 SHA-256 해시.

    비밀번호와 달리 느린 해시를 쓰지 않는다. 토큰은 32바이트 무작위라 사전 공격이
    불가능하고, 요청마다 검증하므로 속도가 중요하다.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_csrf_token() -> str:
    """CSRF 토큰. 쿠키와 헤더에 같은 값을 실어 비교한다(double-submit)."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def csrf_tokens_match(cookie_value: str | None, header_value: str | None) -> bool:
    """CSRF 토큰 일치 여부. 타이밍 공격을 피해 상수 시간 비교를 쓴다."""
    if not cookie_value or not header_value:
        return False
    return hmac.compare_digest(cookie_value, header_value)


@dataclass
class LoginRateLimiter:
    """로그인 시도 레이트 리밋.

    계정과 IP 를 각각 센다. 한 계정을 여러 IP 에서 공격하는 경우와 한 IP 가 여러 계정을
    시도하는 경우를 모두 막아야 한다.
    """

    max_attempts: int = 8
    window_seconds: int = 300
    #: 이보다 많은 키가 쌓이면 창이 지난 키를 비운다. 주소·이메일을 바꿔 가며 보내는 요청이
    #: 프로세스 메모리를 끝없이 늘리지 못하게 한다.
    max_keys: int = 10_000
    _attempts: dict[str, list[float]] = field(default_factory=dict)

    def _recent(self, key: str, now: float) -> list[float]:
        recent = [
            stamp for stamp in self._attempts.get(key, []) if now - stamp < self.window_seconds
        ]
        if recent:
            self._attempts[key] = recent
        else:
            self._attempts.pop(key, None)
        return recent

    def _make_room(self, now: float, keys: list[str]) -> None:
        """새 키를 넣을 자리를 만든다. 넘치면 만료 키 → 시도가 적고 오래된 키 순으로 버린다.

        제한에 걸린 키는 절대 버리지 않는다(버리면 키를 쏟아부어 잠금을 풀 수 있다). 버릴 수
        있는 키가 없으면 새 키를 받지 않고 거부한다(fail closed).
        """
        new = [key for key in keys if key not in self._attempts]
        if len(self._attempts) + len(new) <= self.max_keys:
            return
        for key in list(self._attempts):
            self._recent(key, now)
        evictable = sorted(
            (
                (len(stamps), stamps[-1], key)
                for key, stamps in self._attempts.items()
                if len(stamps) < self.max_attempts and key not in keys
            ),
        )
        while len(self._attempts) + len(new) > self.max_keys and evictable:
            del self._attempts[evictable.pop(0)[2]]
        if len(self._attempts) + len(new) > self.max_keys:
            raise RateLimitedError(self.window_seconds)

    def check(self, *keys: str | None) -> None:
        """제한을 넘었으면 예외를 던진다."""
        now = time.monotonic()
        for key in keys:
            if key is None:
                continue
            recent = self._recent(key, now)
            if len(recent) >= self.max_attempts:
                oldest = min(recent)
                retry_after = int(self.window_seconds - (now - oldest)) + 1
                raise RateLimitedError(retry_after)

    def acquire(self, *keys: str | None) -> None:
        """검사와 시도 기록을 await 없이 한 번에 한다.

        검사 → 비밀번호 확인(await) → 실패 기록 순서면 동시에 들어온 요청이 모두 검사를
        통과해 제한 없이 시도할 수 있다. 시도를 먼저 세고 성공하면 `reset` 으로 지운다.
        """
        self.check(*keys)
        self._make_room(time.monotonic(), [key for key in keys if key is not None])
        self.record_failure(*keys)

    def record_failure(self, *keys: str | None) -> None:
        now = time.monotonic()
        for key in keys:
            if key is None:
                continue
            self._attempts.setdefault(key, []).append(now)

    def reset(self, *keys: str | None) -> None:
        """로그인 성공 시 카운터를 비운다."""
        for key in keys:
            if key is not None:
                self._attempts.pop(key, None)


#: 프로세스 전역 레이트 리미터. 테스트는 `reset_rate_limiter()` 로 초기화한다.
_rate_limiter = LoginRateLimiter()


def _address_group(client_ip: str) -> str:
    """IPv6 는 /64 단위로 묶는다. 한 사용자가 받는 대역 안에서 주소를 바꿔 키를 늘리지 못한다."""
    try:
        address = ipaddress.ip_address(client_ip)
    except ValueError:
        return client_ip
    if address.version == 6:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def get_rate_limiter() -> LoginRateLimiter:
    return _rate_limiter


def reset_rate_limiter() -> None:
    _rate_limiter._attempts.clear()  # noqa: SLF001 - 테스트 편의를 위한 초기화


def normalize_email(email: str) -> str:
    """이메일을 소문자로 정규화한다. 대소문자만 다른 계정이 생기면 로그인이 혼란스럽다."""
    return email.strip().lower()


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    display_name: str,
    role: UserRole = UserRole.OWNER,
) -> User:
    """사용자를 만든다. 비밀번호 정책은 `hash_password` 가 검사한다."""
    user = User(
        email=normalize_email(email),
        display_name=display_name.strip(),
        password_hash=hash_password(password),
        role=role,
    )
    session.add(user)
    await session.flush()
    return user


async def find_user_by_email(session: AsyncSession, email: str) -> User | None:
    return await session.scalar(
        select(User).where(
            User.email == normalize_email(email),
            User.deleted_at.is_(None),
        )
    )


async def authenticate(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    client_ip: str | None = None,
) -> User:
    """이메일·비밀번호로 인증한다.

    사용자가 없는 경우와 비밀번호가 틀린 경우를 **같은 메시지로** 알린다. 구분하면 어떤
    이메일이 등록되어 있는지 알려주는 셈이다.
    """
    limiter = get_rate_limiter()
    normalized = normalize_email(email)
    ip_key = f"ip:{_address_group(client_ip)}" if client_ip else None
    limiter.acquire(f"email:{normalized}", ip_key)

    user = await find_user_by_email(session, normalized)
    # Argon2 확인은 수십 ms 동안 CPU 를 쓴다. 이벤트 루프에서 돌리면 그동안 다른 요청이 멈춘다.
    if (
        user is None
        or not user.is_active
        or not await asyncio.to_thread(verify_password, password, user.password_hash)
    ):
        raise AuthError("이메일 또는 비밀번호가 올바르지 않습니다")

    if needs_rehash(user.password_hash):
        # Argon2 파라미터가 올라갔다. 로그인 시점에 조용히 갱신한다.
        user.password_hash = hash_password(password)

    limiter.reset(f"email:{normalized}", ip_key)
    user.last_login_at = datetime.datetime.now(datetime.UTC)
    await session.flush()
    return user


async def issue_session(
    session: AsyncSession,
    *,
    user: User,
    user_agent: str | None = None,
    client_ip: str | None = None,
    lifetime: datetime.timedelta = SESSION_LIFETIME,
) -> tuple[Session, str]:
    """세션을 발급한다. 반환값은 (레코드, **원문 토큰**) 이다.

    원문 토큰은 이 시점에만 존재한다. DB 에는 해시만 남으므로 나중에 복구할 수 없다.
    """
    token = generate_session_token()
    now = datetime.datetime.now(datetime.UTC)
    record = Session(
        user_id=user.id,
        token_hash=hash_token(token),
        expires_at=now + lifetime,
        last_seen_at=now,
        user_agent=(user_agent or None) and user_agent[:400],
        ip_address=client_ip,
    )
    session.add(record)
    await session.flush()
    return record, token


async def resolve_session(session: AsyncSession, token: str) -> Session | None:
    """토큰으로 사용 가능한 세션을 찾는다. 만료·폐기된 세션은 None 이다."""
    if not token:
        return None
    record = await session.scalar(
        select(Session).where(
            Session.token_hash == hash_token(token),
            Session.deleted_at.is_(None),
        )
    )
    if record is None or not record.is_usable:
        return None
    record.last_seen_at = datetime.datetime.now(datetime.UTC)
    return record


async def revoke_session(session: AsyncSession, token: str) -> bool:
    """세션을 폐기한다. 이미 없거나 만료된 경우도 성공으로 본다(로그아웃은 멱등)."""
    record = await session.scalar(select(Session).where(Session.token_hash == hash_token(token)))
    if record is None:
        return False
    record.revoked_at = datetime.datetime.now(datetime.UTC)
    await session.flush()
    return True


async def revoke_all_sessions(session: AsyncSession, user_id: uuid.UUID) -> int:
    """사용자의 모든 세션을 폐기한다. 기기 분실 시 쓴다."""
    now = datetime.datetime.now(datetime.UTC)
    records = await session.scalars(
        select(Session).where(Session.user_id == user_id, Session.revoked_at.is_(None))
    )
    count = 0
    for record in records:
        record.revoked_at = now
        count += 1
    await session.flush()
    return count


async def purge_expired_sessions(session: AsyncSession) -> int:
    """만료된 세션을 정리한다. 백업 스크립트나 주기 작업에서 호출한다."""
    now = datetime.datetime.now(datetime.UTC)
    records = await session.scalars(
        select(Session).where(Session.expires_at < now, Session.deleted_at.is_(None))
    )
    count = 0
    for record in records:
        record.deleted_at = now
        count += 1
    await session.flush()
    return count
