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
