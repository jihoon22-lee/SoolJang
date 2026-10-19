"""인증 경계: 위조한 X-Forwarded-For, 운영 Secure 쿠키, 동시 로그인 시도 제한."""

import asyncio
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.routes import auth as auth_routes
from sooljang.application.auth import (
    AuthError,
    LoginRateLimiter,
    RateLimitedError,
    authenticate,
    get_rate_limiter,
)
from tests.conftest import TEST_EMAIL, TEST_PASSWORD


def test_spoofed_forwarded_for_does_not_reset_the_ip_limit(
    api_client: TestClient, prefix: str
) -> None:
    """이메일과 맨 앞 X-Forwarded-For 를 매번 바꿔도 같은 접속 주소는 제한에 걸린다."""
    codes = [
        api_client.post(
            f"{prefix}/auth/login",
            json={"email": f"nobody{index}@example.com", "password": "틀린비밀번호1234"},
            # nginx 가 마지막 홉을 X-Real-IP 로 넘기고, 클라이언트는 맨 앞 값을 마음대로 바꾼다.
            headers={"X-Forwarded-For": f"203.0.113.{index}", "X-Real-IP": "192.0.2.10"},
        ).status_code
        for index in range(12)
    ]

    assert 429 in codes, codes


def test_malformed_client_address_does_not_break_login(api_client: TestClient, prefix: str) -> None:
    for headers in ({"X-Forwarded-For": "x" * 100}, {"X-Real-IP": "y" * 100}):
        response = api_client.post(
            f"{prefix}/auth/login",
            json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
            headers=headers,
        )
        assert response.status_code == 200, response.text


def test_production_login_sets_secure_cookies_behind_plain_http_proxy(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    class ProductionSettings:
        is_production = True

    monkeypatch.setattr(auth_routes, "get_settings", lambda: ProductionSettings())

    response = api_client.post(
        f"{prefix}/auth/login",
        json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
        headers={"X-Forwarded-Proto": "http"},
    )

    assert response.status_code == 200, response.text
    cookies = response.headers.get_list("set-cookie")
    assert len(cookies) == 2
    assert all("Secure" in cookie for cookie in cookies), cookies


class _SlowLookupSession:
    """사용자 조회 동안 다른 로그인 요청에 순서를 넘기는 가짜 세션."""

    async def scalar(self, *_: Any) -> None:
        await asyncio.sleep(0.01)


async def test_concurrent_failed_logins_cannot_exceed_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limiter = LoginRateLimiter(max_attempts=3)
    monkeypatch.setattr("sooljang.application.auth._rate_limiter", limiter)
    assert get_rate_limiter() is limiter

    results = await asyncio.gather(
        *(
            authenticate(
                cast(AsyncSession, _SlowLookupSession()),
                email="target@example.com",
                password=f"{TEST_PASSWORD}-wrong",
                client_ip="198.51.100.7",
            )
            for _ in range(10)
        ),
        return_exceptions=True,
    )

    tried = [result for result in results if type(result) is AuthError]
    limited = [result for result in results if isinstance(result, RateLimitedError)]
    assert len(tried) == 3
    assert len(limited) == 7


def test_rate_limiter_drops_expired_keys_when_many_accumulate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr("sooljang.application.auth.time.monotonic", lambda: clock[0])
    limiter = LoginRateLimiter(window_seconds=60, max_keys=5)
    for index in range(5):
        limiter.acquire(f"ip:{index}")
    clock[0] += 61

    limiter.acquire("ip:new")

    assert list(limiter._attempts) == ["ip:new"]  # noqa: SLF001


def test_rate_limiter_cap_never_evicts_locked_keys_and_fails_closed() -> None:
    limiter = LoginRateLimiter(max_attempts=2, max_keys=3)
    for _ in range(2):
        limiter.acquire("email:victim")
    limiter.acquire("ip:a")
    limiter.acquire("ip:b")

    # 가득 찬 상태에서 새 키는 잠기지 않은 키 중 시도가 적은 것을 밀어낸다.
    limiter.acquire("ip:c")
    assert "email:victim" in limiter._attempts  # noqa: SLF001
    assert len(limiter._attempts) == 3  # noqa: SLF001
    for key in ("ip:b", "ip:c"):
        if key in limiter._attempts:  # noqa: SLF001
            limiter.acquire(key)
    # 남은 키가 모두 잠기면 새 키를 받지 않는다.
    with pytest.raises(RateLimitedError):
        limiter.acquire("ip:flood")
    with pytest.raises(RateLimitedError):
        limiter.acquire("email:victim")


def test_ipv6_addresses_in_one_prefix_share_a_limit() -> None:
    from sooljang.application.auth import _address_group

    assert _address_group("2001:db8:1:2::1") == _address_group("2001:db8:1:2:ffff::9")
    assert _address_group("2001:db8:1:3::1") != _address_group("2001:db8:1:2::1")
    assert _address_group("198.51.100.7") == "198.51.100.7"


class _ActiveUser:
    is_active = True
    password_hash = "argon2-hash-placeholder"


class _UserLookupSession:
    async def scalar(self, *_: Any) -> _ActiveUser:
        await asyncio.sleep(0)
        return _ActiveUser()


async def test_concurrent_logins_bound_parallel_argon2_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """허용된 로그인 묶음이 와도 메모리를 크게 쓰는 Argon2 확인은 소수만 동시에 돈다."""
    import threading
    import time

    monkeypatch.setattr("sooljang.application.auth._rate_limiter", LoginRateLimiter())
    lock = threading.Lock()
    running = [0]
    peak = [0]

    def slow_verify(_password: str, _hash: str) -> bool:
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        time.sleep(0.05)
        with lock:
            running[0] -= 1
        return False

    monkeypatch.setattr("sooljang.application.auth.verify_password", slow_verify)

    results = await asyncio.gather(
        *(
            authenticate(
                cast(AsyncSession, _UserLookupSession()),
                email=f"user{index}@example.com",
                password=f"{TEST_PASSWORD}-wrong",
                client_ip=f"198.51.100.{index}",
            )
            for index in range(8)
        ),
        return_exceptions=True,
    )

    assert all(type(result) is AuthError for result in results), results
    assert 1 <= peak[0] <= 2, peak[0]
