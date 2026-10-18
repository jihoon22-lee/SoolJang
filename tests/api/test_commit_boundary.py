"""쓰기 응답은 commit이 끝난 뒤에만 성공으로 나간다."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession


def test_write_reports_failure_when_commit_fails_after_handler(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = AsyncSession.commit

    async def failing_commit(self: AsyncSession, *args: Any, **kwargs: Any) -> None:
        raise ConnectionError("commit lost")

    monkeypatch.setattr(AsyncSession, "commit", failing_commit)
    response = api_client.post(f"{prefix}/vendors", json={"name": "커밋 실패 구매처"})
    monkeypatch.setattr(AsyncSession, "commit", original)

    # 응답이 먼저 나가면 클라이언트는 201을 받고 outbox·초안을 지운다.
    assert response.status_code == 500
    names = [row["name"] for row in api_client.get(f"{prefix}/vendors").json()]
    assert "커밋 실패 구매처" not in names
