"""중첩 요청 가드가 바깥 취소·worker 정책을 유지하고 범위 종료 시 복원한다."""

import asyncio

import httpx
import pytest

from sooljang.infrastructure.external.request_guard import outbound_guard
from sooljang.infrastructure.external.safe_http import SafeHttpClient


async def test_inner_worker_guard_cannot_replace_outer_disconnect_guard() -> None:
    sends: list[str] = []
    reservations: list[str] = []

    async def disconnected(_request: httpx.Request) -> None:
        raise asyncio.CancelledError

    async def worker_running(_request: httpx.Request) -> None:
        return None

    async def reserve(_request: httpx.Request) -> None:
        reservations.append("reserved")

    def respond(request: httpx.Request) -> httpx.Response:
        sends.append(request.url.path)
        return httpx.Response(200)

    async with SafeHttpClient(
        ["example.com"], transport=httpx.MockTransport(respond), before_request=reserve
    ) as client:
        with (
            outbound_guard(disconnected),
            outbound_guard(worker_running),
            pytest.raises(asyncio.CancelledError),
        ):
            await client.get("https://example.com/cancelled")
        assert sends == reservations == []
        assert (await client.get("https://example.com/independent")).status_code == 200
        assert sends == ["/independent"] and reservations == ["reserved"]


async def test_inner_guard_failure_restores_outer_worker_guard_and_finally_clears_it() -> None:
    worker_checks: list[str] = []
    sends: list[str] = []
    stopped = False

    async def worker_guard(request: httpx.Request) -> None:
        worker_checks.append(request.url.path)
        if stopped:
            raise RuntimeError("worker stopped")

    async def source_guard(_request: httpx.Request) -> None:
        raise ValueError("source changed")

    def respond(request: httpx.Request) -> httpx.Response:
        sends.append(request.url.path)
        return httpx.Response(200)

    async with SafeHttpClient(["example.com"], transport=httpx.MockTransport(respond)) as client:
        with outbound_guard(worker_guard):
            with outbound_guard(source_guard), pytest.raises(ValueError, match="source changed"):
                await client.get("https://example.com/changed")
            assert (await client.get("https://example.com/outer")).status_code == 200
            stopped = True
            with pytest.raises(RuntimeError, match="worker stopped"):
                await client.get("https://example.com/stopped")
        assert (await client.get("https://example.com/independent")).status_code == 200
    assert sends == ["/outer", "/independent"]
    assert "/changed" in worker_checks and "/stopped" in worker_checks
    assert "/independent" not in worker_checks
