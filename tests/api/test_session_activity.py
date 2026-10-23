"""인증 활동 시각은 느린 업무 요청과 다른 요청을 직렬화하지 않는다."""

import asyncio
import datetime
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from sooljang.api import deps
from sooljang.api.routes import auth as auth_routes
from sooljang.api.routes.auth import CSRF_HEADER, SESSION_COOKIE
from sooljang.application import auth, discovery
from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.database.models import Session
from sooljang.infrastructure.database.session import get_engine, get_session_factory
from sooljang.infrastructure.external.search import SearchResult
from tests.api.test_provider_connections import create, patch
from tests.conftest import TEST_EMAIL, TEST_PASSWORD


def _activity(
    client: TestClient,
    *,
    ago: datetime.timedelta | None = None,
    session_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    token_hash = auth.hash_token(client.cookies[SESSION_COOKIE]) if session_id is None else None

    async def read() -> dict[str, Any]:
        async with get_session_factory().begin() as session:
            record = (
                await session.get(Session, session_id)
                if session_id is not None
                else await session.scalar(select(Session).where(Session.token_hash == token_hash))
            )
            assert record is not None
            if ago is not None:
                record.last_seen_at = datetime.datetime.now(datetime.UTC) - ago
            return {
                "id": record.id,
                "user_id": record.user_id,
                "last_seen_at": record.last_seen_at,
                "expires_at": record.expires_at,
                "revoked_at": record.revoked_at,
            }

    assert client.portal is not None
    return client.portal.call(read)


@pytest.mark.parametrize("other_request", ["read", "write", "logout"])
def test_slow_external_request_does_not_block_another_request_with_the_same_cookie(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, other_request: str
) -> None:
    connection = create(api_client, prefix, kind="exa", values={"api_key": "synthetic-session-key"})
    assert patch(api_client, prefix, connection, is_active=True).status_code == 200
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    held, release, completed = (threading.Event() for _ in range(3))

    async def slow_search(*args: Any, **kwargs: Any) -> SearchResult:
        held.set()
        assert await asyncio.to_thread(release.wait, 5)
        return SearchResult(SourceOutcome.SUCCESS)

    def another_request() -> Any:
        try:
            if other_request == "logout":
                return api_client.post(f"{prefix}/auth/logout")
            return (
                api_client.get(f"{prefix}/products")
                if other_request == "read"
                else api_client.post(f"{prefix}/vendors", json={"name": "검색 중 저장한 구매처"})
            )
        finally:
            completed.set()

    monkeypatch.setattr(discovery, "search_provider", slow_search)
    with ThreadPoolExecutor(max_workers=2) as pool:
        searching = pool.submit(
            api_client.post,
            f"{prefix}/discovery/search",
            json={"connection_id": connection["id"], "query": "합성 위스키"},
        )
        try:
            assert held.wait(5)
            other = pool.submit(another_request)
            completed_while_searching = completed.wait(1)
        finally:
            release.set()
        search_response, other_response = searching.result(timeout=10), other.result(timeout=10)

    assert search_response.status_code == 200, search_response.text
    assert other_response.status_code == {"read": 200, "write": 201, "logout": 204}[other_request]
    assert completed_while_searching, "같은 로그인 쿠키의 요청이 외부 응답을 기다렸습니다"
    after = _activity(api_client, session_id=before["id"])
    assert after["expires_at"] == before["expires_at"]
    if other_request == "logout":
        assert after["last_seen_at"] == before["last_seen_at"]
        assert after["revoked_at"] is not None
        assert api_client.get(f"{prefix}/products").status_code == 401
        return
    assert after["last_seen_at"] > before["last_seen_at"]
    assert after["revoked_at"] is None
    if other_request == "write":
        assert [vendor["name"] for vendor in api_client.get(f"{prefix}/vendors").json()] == [
            "검색 중 저장한 구매처"
        ]


def test_activity_is_throttled_and_delayed_observations_never_move_it_backwards(
    api_client: TestClient, prefix: str
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    now = datetime.datetime.now(datetime.UTC)
    observed = now - datetime.timedelta(minutes=10)

    async def touch(when: datetime.datetime) -> None:
        await auth.touch_session_activity(
            session_id=before["id"], user_id=before["user_id"], observed_at=when
        )

    assert api_client.portal is not None
    api_client.portal.call(touch, observed)
    assert _activity(api_client)["last_seen_at"] == observed
    api_client.portal.call(touch, observed - datetime.timedelta(minutes=10))
    api_client.portal.call(touch, observed + datetime.timedelta(minutes=1))
    assert _activity(api_client)["last_seen_at"] == observed
    later = observed + datetime.timedelta(minutes=6)
    api_client.portal.call(touch, later)
    assert _activity(api_client)["last_seen_at"] == later
    assert api_client.get(f"{prefix}/auth/me").status_code == 200
    # 마지막 갱신 후 5분 안에는 API 요청도 관찰값을 다시 쓰지 않는다.
    assert _activity(api_client)["last_seen_at"] == later
    assert _activity(api_client)["expires_at"] == before["expires_at"]


@pytest.mark.parametrize("invalid", ["expired", "revoked", "deleted", "other_user", "missing"])
def test_activity_does_not_refresh_expired_revoked_or_another_users_session(
    api_client: TestClient, prefix: str, invalid: str
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    now = datetime.datetime.now(datetime.UTC)

    async def change_and_touch() -> None:
        async with get_session_factory().begin() as session:
            record = await session.get(Session, before["id"])
            assert record is not None
            if invalid == "expired":
                record.expires_at = now - datetime.timedelta(seconds=1)
            elif invalid == "revoked":
                record.revoked_at = now
            elif invalid == "deleted":
                record.deleted_at = now
        await auth.touch_session_activity(
            session_id=uuid.uuid4() if invalid == "missing" else before["id"],
            user_id=uuid.uuid4() if invalid == "other_user" else before["user_id"],
            observed_at=now,
        )

    assert api_client.portal is not None
    api_client.portal.call(change_and_touch)
    assert _activity(api_client)["last_seen_at"] == before["last_seen_at"]
    if invalid in {"expired", "revoked", "deleted"}:
        assert api_client.get(f"{prefix}/auth/me").status_code == 401


def test_missing_activity_is_recorded_after_a_valid_request(
    api_client: TestClient, prefix: str
) -> None:
    before = _activity(api_client)

    async def clear_activity() -> None:
        async with get_session_factory().begin() as session:
            record = await session.get(Session, before["id"])
            assert record is not None
            record.last_seen_at = None

    assert api_client.portal is not None
    api_client.portal.call(clear_activity)
    assert api_client.get(f"{prefix}/auth/me").status_code == 200
    after = _activity(api_client)
    assert after["last_seen_at"] is not None
    assert after["expires_at"] == before["expires_at"]


def test_invalid_csrf_does_not_refresh_activity(api_client: TestClient, prefix: str) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    response = api_client.post(
        f"{prefix}/vendors", json={"name": "거부할 입력"}, headers={CSRF_HEADER: "wrong-token"}
    )
    assert response.status_code == 403
    assert _activity(api_client)["last_seen_at"] == before["last_seen_at"]


def test_activity_can_use_the_only_connection_after_the_request_returns_it(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    engine = create_async_engine(get_engine().url, pool_size=1, max_overflow=0)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(deps, "get_session_factory", lambda: factory)
    monkeypatch.setattr(auth, "get_session_factory", lambda: factory)
    assert api_client.portal is not None
    try:
        assert api_client.get(f"{prefix}/auth/me").status_code == 200
        assert _activity(api_client)["last_seen_at"] > before["last_seen_at"]
    finally:
        api_client.portal.call(engine.dispose)


def test_activity_deadline_includes_waiting_for_a_pool_connection(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    engine = create_async_engine(get_engine().url, pool_size=1, max_overflow=0, pool_timeout=30)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(auth, "get_session_factory", lambda: factory)
    monkeypatch.setattr(auth, "SESSION_ACTIVITY_TIMEOUT_SECONDS", 0.02)

    async def occupy_pool() -> None:
        try:
            async with engine.connect():
                await asyncio.wait_for(
                    auth.touch_session_activity(
                        session_id=before["id"],
                        user_id=before["user_id"],
                        observed_at=datetime.datetime.now(datetime.UTC),
                    ),
                    timeout=1,
                )
        finally:
            await engine.dispose()

    assert api_client.portal is not None
    api_client.portal.call(occupy_pool)
    assert _activity(api_client)["last_seen_at"] == before["last_seen_at"]


def test_activity_skips_a_session_locked_by_another_transaction(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    monkeypatch.setattr(auth, "SESSION_ACTIVITY_TIMEOUT_SECONDS", 5)

    async def lock_and_touch() -> None:
        async with get_session_factory().begin() as locking:
            await locking.scalar(
                select(Session.id).where(Session.id == before["id"]).with_for_update()
            )
            await asyncio.wait_for(
                auth.touch_session_activity(
                    session_id=before["id"],
                    user_id=before["user_id"],
                    observed_at=datetime.datetime.now(datetime.UTC),
                ),
                timeout=1,
            )

    assert api_client.portal is not None
    api_client.portal.call(lock_and_touch)
    assert _activity(api_client)["last_seen_at"] == before["last_seen_at"]


def test_activity_failure_does_not_change_a_committed_business_result(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))

    def unavailable() -> Any:
        raise OSError("synthetic activity failure")

    monkeypatch.setattr(auth, "get_session_factory", unavailable)
    response = api_client.post(f"{prefix}/vendors", json={"name": "확정된 구매처"})
    assert response.status_code == 201, response.text
    assert _activity(api_client)["last_seen_at"] == before["last_seen_at"]
    assert [vendor["name"] for vendor in api_client.get(f"{prefix}/vendors").json()] == [
        "확정된 구매처"
    ]


def test_failed_business_commit_does_not_refresh_activity_or_report_success(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _activity(api_client, ago=datetime.timedelta(hours=1))
    original_commit = AsyncSession.commit

    async def fail_commit(self: AsyncSession) -> None:
        raise ConnectionError("synthetic commit failure")

    monkeypatch.setattr(AsyncSession, "commit", fail_commit)
    response = api_client.post(f"{prefix}/vendors", json={"name": "롤백할 구매처"})
    monkeypatch.setattr(AsyncSession, "commit", original_commit)
    assert response.status_code == 500
    assert _activity(api_client)["last_seen_at"] == before["last_seen_at"]
    assert api_client.get(f"{prefix}/vendors").json() == []


def test_concurrent_password_changes_recheck_the_latest_password(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    held, release, completed = (threading.Event() for _ in range(3))
    original_revoke = auth_routes.revoke_all_sessions
    first_password = "first-new-password-1234"  # scan-secrets-allow: synthetic fixture
    second_password = "second-new-password-1234"  # scan-secrets-allow: synthetic fixture

    async def pause_after_password_check(*args: Any, **kwargs: Any) -> int:
        if not held.is_set():
            held.set()
            assert await asyncio.to_thread(release.wait, 5)
        return await original_revoke(*args, **kwargs)

    def second_change() -> Any:
        try:
            return api_client.post(
                f"{prefix}/auth/password",
                json={"current_password": TEST_PASSWORD, "new_password": second_password},
            )
        finally:
            completed.set()

    monkeypatch.setattr(auth_routes, "revoke_all_sessions", pause_after_password_check)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(
            api_client.post,
            f"{prefix}/auth/password",
            json={"current_password": TEST_PASSWORD, "new_password": first_password},
        )
        try:
            assert held.wait(5)
            second = pool.submit(second_change)
            completed.wait(0.5)
        finally:
            release.set()
        first_result, second_result = first.result(timeout=10), second.result(timeout=10)

    assert first_result.status_code == 204, first_result.text
    assert second_result.status_code == 401, second_result.text
    assert api_client.get(f"{prefix}/auth/me").status_code == 200
    assert api_client.post(f"{prefix}/auth/logout").status_code == 204
    assert (
        api_client.post(
            f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": first_password}
        ).status_code
        == 200
    )
    assert (
        api_client.post(
            f"{prefix}/auth/login", json={"email": TEST_EMAIL, "password": second_password}
        ).status_code
        == 401
    )
