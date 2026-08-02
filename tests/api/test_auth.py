"""인증 API 통합 테스트.

인증은 "막아야 할 것을 막는지"가 핵심이라, 통과 경로보다 거부 경로를 더 촘촘히 본다.
"""

import datetime

import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes.auth import CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE
from tests.conftest import TEST_DISPLAY_NAME, TEST_EMAIL, TEST_PASSWORD

SETUP_PAYLOAD = {
    "email": TEST_EMAIL,
    "password": TEST_PASSWORD,
    "display_name": TEST_DISPLAY_NAME,
}


class TestSetup:
    def test_사용자가_없으면_설정이_필요하다고_알린다(
        self, anon_client: TestClient, prefix: str
    ) -> None:
        response = anon_client.get(f"{prefix}/auth/setup")
        assert response.status_code == 200
        assert response.json() == {"needs_setup": True}

    def test_최초_사용자를_만들고_바로_로그인된다(
        self, anon_client: TestClient, prefix: str
    ) -> None:
        response = anon_client.post(f"{prefix}/auth/setup", json=SETUP_PAYLOAD)
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["user"]["email"] == TEST_EMAIL
        assert body["user"]["role"] == "owner"
        assert body["csrf_token"]
        # 세션 쿠키가 심어졌고 httpOnly 다.
        assert SESSION_COOKIE in response.cookies
        set_cookie = response.headers.get("set-cookie", "")
        assert "httponly" in set_cookie.lower()

    def test_세션_토큰은_응답_본문에_없다(self, anon_client: TestClient, prefix: str) -> None:
        # 본문에 실으면 JavaScript 가 읽을 수 있어 httpOnly 의 의미가 사라진다.
        response = anon_client.post(f"{prefix}/auth/setup", json=SETUP_PAYLOAD)
        token = response.cookies[SESSION_COOKIE]
        assert token not in response.text

    def test_설정_후에는_필요없다고_알린다(self, api_client: TestClient, prefix: str) -> None:
        assert api_client.get(f"{prefix}/auth/setup").json() == {"needs_setup": False}

    def test_이미_사용자가_있으면_거부한다(self, api_client: TestClient, prefix: str) -> None:
        # 그러지 않으면 누구나 계정을 만들 수 있다.
        response = api_client.post(f"{prefix}/auth/setup", json=SETUP_PAYLOAD)
        assert response.status_code == 409

    def test_짧은_비밀번호를_거부한다(self, anon_client: TestClient, prefix: str) -> None:
        response = anon_client.post(
            f"{prefix}/auth/setup", json={**SETUP_PAYLOAD, "password": "짧다"}
        )
        assert response.status_code == 422
        assert any(error["field"] == "password" for error in response.json()["errors"])

    def test_잘못된_이메일을_거부한다(self, anon_client: TestClient, prefix: str) -> None:
        response = anon_client.post(
            f"{prefix}/auth/setup", json={**SETUP_PAYLOAD, "email": "이메일아님"}
        )
        assert response.status_code == 422


class TestLogin:
    def test_올바른_자격증명으로_로그인한다(self, api_client: TestClient, prefix: str) -> None:
        api_client.post(f"{prefix}/auth/logout")
        response = api_client.post(
            f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, response.text
        assert response.json()["user"]["email"] == TEST_EMAIL

    def test_대소문자가_달라도_로그인된다(self, api_client: TestClient, prefix: str) -> None:
        api_client.post(f"{prefix}/auth/logout")
        response = api_client.post(
            f"{prefix}/auth/login",
            json={"email": TEST_EMAIL.upper(), "password": TEST_PASSWORD},
        )
        assert response.status_code == 200, response.text

    def test_틀린_비밀번호를_거부한다(self, api_client: TestClient, prefix: str) -> None:
        response = api_client.post(
            f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": "틀린비밀번호1234"}
        )
        assert response.status_code == 401

    def test_없는_사용자와_틀린_비밀번호가_같은_메시지다(
        self, api_client: TestClient, prefix: str
    ) -> None:
        # 구분하면 어떤 이메일이 등록되어 있는지 알려주는 셈이다.
        wrong_password = api_client.post(
            f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": "틀린비밀번호1234"}
        )
        unknown_user = api_client.post(
            f"{prefix}/auth/login",
            json={"email": "nobody@example.com", "password": "틀린비밀번호1234"},
        )
        assert wrong_password.status_code == unknown_user.status_code == 401
        assert wrong_password.json()["detail"] == unknown_user.json()["detail"]

    def test_반복_실패는_레이트리밋에_걸린다(self, api_client: TestClient, prefix: str) -> None:
        codes = [
            api_client.post(
                f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": "틀린비밀번호1234"}
            ).status_code
            for _ in range(12)
        ]
        assert 429 in codes, f"레이트리밋이 동작하지 않았다: {codes}"


class TestMe:
    def test_로그인한_사용자를_반환한다(self, api_client: TestClient, prefix: str) -> None:
        response = api_client.get(f"{prefix}/auth/me")
        assert response.status_code == 200
        assert response.json()["email"] == TEST_EMAIL

    def test_비밀번호_해시를_노출하지_않는다(self, api_client: TestClient, prefix: str) -> None:
        assert "password" not in api_client.get(f"{prefix}/auth/me").text

    def test_로그인하지_않으면_401(self, anon_client: TestClient, prefix: str) -> None:
        assert anon_client.get(f"{prefix}/auth/me").status_code == 401


class TestLogout:
    def test_로그아웃하면_세션이_무효화된다(self, api_client: TestClient, prefix: str) -> None:
        assert api_client.post(f"{prefix}/auth/logout").status_code == 204
        assert api_client.get(f"{prefix}/auth/me").status_code == 401

    def test_로그아웃은_멱등하다(self, api_client: TestClient, prefix: str) -> None:
        api_client.post(f"{prefix}/auth/logout")
        assert api_client.post(f"{prefix}/auth/logout").status_code == 204

    def test_폐기된_토큰은_재사용할_수_없다(self, api_client: TestClient, prefix: str) -> None:
        token = api_client.cookies[SESSION_COOKIE]
        api_client.post(f"{prefix}/auth/logout")
        api_client.cookies.set(SESSION_COOKIE, token)
        assert api_client.get(f"{prefix}/auth/me").status_code == 401


class TestProtectedEndpoints:
    ENDPOINTS = [
        ("get", "/categories"),
        ("get", "/products"),
        ("get", "/vendors"),
    ]

    @pytest.mark.parametrize(("method", "path"), ENDPOINTS)
    def test_인증_없이는_거부된다(
        self, anon_client: TestClient, prefix: str, method: str, path: str
    ) -> None:
        response = getattr(anon_client, method)(f"{prefix}{path}")
        assert response.status_code == 401, f"{path} 가 인증 없이 열려 있다"

    @pytest.mark.parametrize(("method", "path"), ENDPOINTS)
    def test_인증하면_통과한다(
        self, api_client: TestClient, prefix: str, method: str, path: str
    ) -> None:
        response = getattr(api_client, method)(f"{prefix}{path}")
        assert response.status_code == 200, response.text

    def test_health_는_인증_없이_열려_있다(self, anon_client: TestClient, prefix: str) -> None:
        # 컨테이너 헬스체크가 인증 없이 호출한다.
        assert anon_client.get(f"{prefix}/health").status_code == 200

    def test_만료된_세션은_거부된다(self, api_client: TestClient, prefix: str) -> None:
        import asyncio

        from sqlalchemy import update
        from sqlalchemy.ext.asyncio import create_async_engine

        from sooljang.infrastructure.database.models import Session
        from tests.conftest import _database_url

        async def expire() -> None:
            engine = create_async_engine(_database_url())
            try:
                async with engine.begin() as conn:
                    await conn.execute(
                        update(Session).values(
                            expires_at=datetime.datetime.now(datetime.UTC)
                            - datetime.timedelta(seconds=1)
                        )
                    )
            finally:
                await engine.dispose()

        asyncio.run(expire())
        assert api_client.get(f"{prefix}/auth/me").status_code == 401


class TestCsrf:
    def test_CSRF_헤더가_없으면_쓰기가_거부된다(self, api_client: TestClient, prefix: str) -> None:
        del api_client.headers[CSRF_HEADER]
        response = api_client.post(f"{prefix}/categories", json={"name": "테스트"})
        assert response.status_code == 403
        assert response.json()["type"].endswith("csrf-mismatch")

    def test_CSRF_헤더가_틀리면_쓰기가_거부된다(self, api_client: TestClient, prefix: str) -> None:
        # HTTP 헤더는 ASCII 만 허용하므로 한글을 쓸 수 없다.
        api_client.headers[CSRF_HEADER] = "wrong-token"
        response = api_client.post(f"{prefix}/categories", json={"name": "테스트"})
        assert response.status_code == 403

    def test_CSRF_쿠키가_없으면_쓰기가_거부된다(self, api_client: TestClient, prefix: str) -> None:
        api_client.cookies.delete(CSRF_COOKIE)
        response = api_client.post(f"{prefix}/categories", json={"name": "테스트"})
        assert response.status_code == 403

    def test_읽기는_CSRF_없이_가능하다(self, api_client: TestClient, prefix: str) -> None:
        # GET 은 상태를 바꾸지 않으므로 CSRF 검사 대상이 아니다.
        del api_client.headers[CSRF_HEADER]
        assert api_client.get(f"{prefix}/categories").status_code == 200

    def test_올바른_CSRF_로_쓰기가_통과한다(self, api_client: TestClient, prefix: str) -> None:
        response = api_client.post(f"{prefix}/categories", json={"name": "CSRF 통과 확인"})
        assert response.status_code == 201, response.text


class TestPasswordChange:
    NEW_PASSWORD = "새로운비밀번호5678"

    def test_비밀번호를_바꾸고_새_비밀번호로_로그인한다(
        self, api_client: TestClient, prefix: str
    ) -> None:
        response = api_client.post(
            f"{prefix}/auth/password",
            json={"current_password": TEST_PASSWORD, "new_password": self.NEW_PASSWORD},
        )
        assert response.status_code == 204, response.text

        api_client.post(f"{prefix}/auth/logout")
        assert (
            api_client.post(
                f"{prefix}/auth/login",
                json={"email": TEST_EMAIL, "password": self.NEW_PASSWORD},
            ).status_code
            == 200
        )

    def test_현재_비밀번호가_틀리면_거부한다(self, api_client: TestClient, prefix: str) -> None:
        response = api_client.post(
            f"{prefix}/auth/password",
            json={"current_password": "틀린비밀번호1234", "new_password": self.NEW_PASSWORD},
        )
        assert response.status_code == 401

    def test_짧은_새_비밀번호를_거부한다(self, api_client: TestClient, prefix: str) -> None:
        response = api_client.post(
            f"{prefix}/auth/password",
            json={"current_password": TEST_PASSWORD, "new_password": "짧다"},
        )
        assert response.status_code == 422

    def test_변경_후에도_현재_세션은_유지된다(self, api_client: TestClient, prefix: str) -> None:
        # 다른 세션은 폐기하지만 지금 쓰는 세션까지 끊으면 즉시 로그아웃되어 불편하다.
        api_client.post(
            f"{prefix}/auth/password",
            json={"current_password": TEST_PASSWORD, "new_password": self.NEW_PASSWORD},
        )
        assert api_client.get(f"{prefix}/auth/me").status_code == 200

    def test_변경하면_다른_세션이_폐기된다(self, api_client: TestClient, prefix: str) -> None:
        import asyncio

        from sqlalchemy import func, select
        from sqlalchemy.ext.asyncio import create_async_engine

        from sooljang.infrastructure.database.models import Session
        from tests.conftest import _database_url

        # 두 번째 기기에서 로그인한 상황을 만든다.
        second = TestClient(api_client.app, raise_server_exceptions=False)  # type: ignore[attr-defined]
        assert (
            second.post(
                f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": TEST_PASSWORD}
            ).status_code
            == 200
        )

        api_client.post(
            f"{prefix}/auth/password",
            json={"current_password": TEST_PASSWORD, "new_password": self.NEW_PASSWORD},
        )

        async def count_active() -> int:
            engine = create_async_engine(_database_url())
            try:
                async with engine.begin() as conn:
                    result = await conn.execute(
                        select(func.count())
                        .select_from(Session)
                        .where(Session.revoked_at.is_(None))
                    )
                    return int(result.scalar_one())
            finally:
                await engine.dispose()

        # 현재 세션 하나만 살아 있어야 한다.
        assert asyncio.run(count_active()) == 1
