"""인증 서비스 단위 테스트.

비밀번호 해시와 토큰 취급은 틀려도 조용히 동작하는 영역이라 경계를 촘촘히 본다.
"""

import datetime

import pytest

from sooljang.application.auth import (
    MIN_PASSWORD_LENGTH,
    LoginRateLimiter,
    RateLimitedError,
    WeakPasswordError,
    csrf_tokens_match,
    generate_csrf_token,
    generate_session_token,
    hash_password,
    hash_token,
    needs_rehash,
    normalize_email,
    verify_password,
)

#: 테스트용 비밀번호. 실제 자격증명이 아니다. scan-secrets-allow
VALID_PASSWORD = "충분히긴비밀번호1234"  # scan-secrets-allow
WRONG_PASSWORD = "충분히긴비밀번호12345"  # scan-secrets-allow


class TestPasswordHashing:
    def test_해시는_원문을_담지_않는다(self) -> None:
        password = VALID_PASSWORD
        digest = hash_password(password)
        assert password not in digest
        assert digest.startswith("$argon2id$"), "Argon2id 를 써야 한다"

    def test_같은_비밀번호도_해시가_매번_다르다(self) -> None:
        # 솔트가 다르기 때문이다. 같으면 레인보우 테이블에 취약하다.
        password = VALID_PASSWORD
        assert hash_password(password) != hash_password(password)

    def test_올바른_비밀번호를_검증한다(self) -> None:
        digest = hash_password(VALID_PASSWORD)
        assert verify_password(VALID_PASSWORD, digest) is True

    def test_틀린_비밀번호를_거부한다(self) -> None:
        digest = hash_password(VALID_PASSWORD)
        assert verify_password(WRONG_PASSWORD, digest) is False

    def test_깨진_해시는_예외_대신_False(self) -> None:
        # DB 가 손상되었더라도 500 이 아니라 인증 실패로 다뤄야 한다.
        assert verify_password("무엇이든", "이건해시가아니다") is False
        assert verify_password("무엇이든", "") is False

    @pytest.mark.parametrize("password", ["", "짧음", "a" * (MIN_PASSWORD_LENGTH - 1)])
    def test_짧은_비밀번호를_거부한다(self, password: str) -> None:
        with pytest.raises(WeakPasswordError):
            hash_password(password)

    def test_최소_길이는_통과한다(self) -> None:
        assert hash_password("a" * MIN_PASSWORD_LENGTH)

    def test_현재_파라미터는_재해시가_불필요하다(self) -> None:
        assert needs_rehash(hash_password(VALID_PASSWORD)) is False

    def test_깨진_해시는_재해시_판정에서도_안전하다(self) -> None:
        assert needs_rehash("이건해시가아니다") is False


class TestTokens:
    def test_세션_토큰은_매번_다르다(self) -> None:
        tokens = {generate_session_token() for _ in range(50)}
        assert len(tokens) == 50

    def test_세션_토큰_길이가_충분하다(self) -> None:
        # 32바이트를 base64url 로 인코딩하면 43자다.
        assert len(generate_session_token()) >= 43

    def test_토큰_해시는_결정적이고_원문을_담지_않는다(self) -> None:
        token = generate_session_token()
        assert hash_token(token) == hash_token(token)
        assert token not in hash_token(token)
        assert len(hash_token(token)) == 64, "SHA-256 16진 표현은 64자"

    def test_다른_토큰은_다른_해시(self) -> None:
        assert hash_token("a") != hash_token("b")


class TestCsrf:
    def test_같은_토큰은_일치(self) -> None:
        token = generate_csrf_token()
        assert csrf_tokens_match(token, token) is True

    def test_다른_토큰은_불일치(self) -> None:
        assert csrf_tokens_match(generate_csrf_token(), generate_csrf_token()) is False

    @pytest.mark.parametrize(
        ("cookie", "header"),
        [(None, "x"), ("x", None), (None, None), ("", ""), ("x", "")],
    )
    def test_비어있으면_불일치(self, cookie: str | None, header: str | None) -> None:
        # 둘 다 빈 값일 때 "일치"로 판정하면 CSRF 방어가 통째로 무력화된다.
        assert csrf_tokens_match(cookie, header) is False


class TestRateLimiter:
    def test_상한까지는_통과한다(self) -> None:
        limiter = LoginRateLimiter(max_attempts=3, window_seconds=300)
        for _ in range(3):
            limiter.check("email:a")
            limiter.record_failure("email:a")
        with pytest.raises(RateLimitedError):
            limiter.check("email:a")

    def test_재시도_시간을_알려준다(self) -> None:
        limiter = LoginRateLimiter(max_attempts=1, window_seconds=300)
        limiter.record_failure("email:a")
        with pytest.raises(RateLimitedError) as excinfo:
            limiter.check("email:a")
        assert 0 < excinfo.value.retry_after_seconds <= 301

    def test_성공하면_카운터가_비워진다(self) -> None:
        limiter = LoginRateLimiter(max_attempts=2)
        limiter.record_failure("email:a")
        limiter.reset("email:a")
        limiter.record_failure("email:a")
        limiter.check("email:a")  # 예외 없음

    def test_키가_분리된다(self) -> None:
        # 한 계정이 막혀도 다른 계정은 영향받지 않아야 한다.
        limiter = LoginRateLimiter(max_attempts=1)
        limiter.record_failure("email:a")
        limiter.check("email:b")
        with pytest.raises(RateLimitedError):
            limiter.check("email:a")

    def test_None_키는_무시한다(self) -> None:
        # IP 를 알 수 없는 경우(테스트 클라이언트 등)에도 동작해야 한다.
        limiter = LoginRateLimiter(max_attempts=1)
        limiter.record_failure("email:a", None)
        limiter.check(None)

    def test_창이_지나면_초기화된다(self) -> None:
        limiter = LoginRateLimiter(max_attempts=1, window_seconds=0)
        limiter.record_failure("email:a")
        limiter.check("email:a")  # 창이 0초라 즉시 만료


class TestEmailNormalization:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Foo@Example.COM", "foo@example.com"),
            ("  foo@example.com  ", "foo@example.com"),
            ("FOO@EXAMPLE.COM", "foo@example.com"),
        ],
    )
    def test_소문자와_공백을_정규화한다(self, raw: str, expected: str) -> None:
        # 대소문자만 다른 계정이 생기면 로그인이 혼란스럽다.
        assert normalize_email(raw) == expected


class TestSessionUsability:
    def test_만료_판정에_시간대가_반영된다(self) -> None:
        from sooljang.infrastructure.database.models import Session

        past = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=1)
        future = datetime.datetime.now(datetime.UTC) + datetime.timedelta(days=1)
        assert Session(token_hash="x", expires_at=future).is_usable is True
        assert Session(token_hash="x", expires_at=past).is_usable is False

    def test_폐기된_세션은_사용불가(self) -> None:
        from sooljang.infrastructure.database.models import Session

        future = datetime.datetime.now(datetime.UTC) + datetime.timedelta(days=1)
        record = Session(token_hash="x", expires_at=future)
        record.revoked_at = datetime.datetime.now(datetime.UTC)
        assert record.is_usable is False

    def test_soft_delete_된_세션은_사용불가(self) -> None:
        from sooljang.infrastructure.database.models import Session

        future = datetime.datetime.now(datetime.UTC) + datetime.timedelta(days=1)
        record = Session(token_hash="x", expires_at=future)
        record.deleted_at = datetime.datetime.now(datetime.UTC)
        assert record.is_usable is False
