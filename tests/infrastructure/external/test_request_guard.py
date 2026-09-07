"""작업별 가드는 기존 보안·예산 경계를 유지하며 다른 async 요청으로 새지 않는다."""

import asyncio

import httpx
import pytest

from sooljang.infrastructure.external.request_guard import outbound_guard
from sooljang.infrastructure.external.safe_http import SafeHttpClient, UnsafeRequest


async def test_cancelled_scope_stops_before_budget_and_transport_then_resets() -> None:
    sent = []
    budget = []

    async def reserve(request: httpx.Request) -> None:
        budget.append(request.url.path)

    async def stopped(_request: httpx.Request) -> None:
        raise UnsafeRequest("synthetic stopped job")

    transport = httpx.MockTransport(
        lambda request: sent.append(request.url.path) or httpx.Response(200)
    )
    async with SafeHttpClient(
        ["example.com"], before_request=reserve, transport=transport
    ) as client:
        with pytest.raises(UnsafeRequest), outbound_guard(stopped):
            await client.get("https://example.com/stopped")
        await client.get("https://example.com/normal")
    assert sent == budget == ["/normal"]


async def test_parallel_user_request_does_not_inherit_another_jobs_guard() -> None:
    sent = []

    async def guarded() -> None:
        async def stopped(_request: httpx.Request) -> None:
            raise UnsafeRequest("synthetic stopped job")

        with outbound_guard(stopped):
            async with SafeHttpClient(
                ["example.com"], transport=httpx.MockTransport(lambda _: httpx.Response(200))
            ) as client:
                with pytest.raises(UnsafeRequest):
                    await client.get("https://example.com/stopped")

    async def normal() -> None:
        async with SafeHttpClient(
            ["example.com"],
            transport=httpx.MockTransport(
                lambda request: sent.append(request.url.path) or httpx.Response(200)
            ),
        ) as client:
            await client.get("https://example.com/normal")

    await asyncio.gather(guarded(), normal())
    assert sent == ["/normal"]


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
