"""인증 경계: 위조한 X-Forwarded-For, 운영 Secure 쿠키, 동시 로그인 시도 제한."""

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

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
                _SlowLookupSession(),  # type: ignore[arg-type]
                email="target@example.com",
                password="틀린비밀번호1234",
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


def test_rate_limiter_cap_holds_even_when_all_keys_are_recent() -> None:
    limiter = LoginRateLimiter(max_keys=5)
    for index in range(20):
        limiter.acquire(f"ip:{index}")
    limiter.acquire("ip:0")

    assert len(limiter._attempts) == 5  # noqa: SLF001
    assert "ip:0" in limiter._attempts  # noqa: SLF001
