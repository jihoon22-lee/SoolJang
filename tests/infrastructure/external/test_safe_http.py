"""실제 외부 네트워크 없이 URL부터 TCP/TLS 경계까지 검증한다."""

import asyncio
import gzip
import ssl
import zlib
from collections.abc import AsyncIterator, Iterable
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from typing import Any

import httpcore
import httpx
import pytest

from sooljang.infrastructure.external.safe_http import (
    HttpLimits,
    ResponseTooLarge,
    SafeHttpClient,
    UnsafeRequest,
    _PinnedBackend,
    _retry_delay,
    resolve_public_addresses,
)

HOST = "catalog.example"
PUBLIC_IP = "93.184.216.34"


async def public_dns(host: str, port: int) -> list[str]:
    return [PUBLIC_IP]


@pytest.mark.parametrize(
    "url",
    [
        "ftp://catalog.example/x",
        "file:///etc/passwd",
        "https://user:password@catalog.example/x",
        "https://catalog.example:8443/x",
        "http://catalog.example:443/x",
        "https://evil.example/x",
        "https://catalog.example.evil.example/x",
        "https://catalog.example./x",
        "https://127.0.0.1/x",
        "https://169.254.169.254/latest/meta-data",
        "http://[::1]/x",
        "http://[::ffff:127.0.0.1]/x",
        "https://catalog.example\\@evil.example/x",
        "https://catalog.example/x\n",
        "http://localhost/x",
        "http://2130706433/x",
    ],
)
async def test_unsafe_url_never_reaches_transport_or_budget(url: str) -> None:
    calls: list[httpx.Request] = []

    async def budget(request: httpx.Request) -> None:
        calls.append(request)

    async with SafeHttpClient(
        [HOST],
        transport=httpx.MockTransport(lambda request: pytest.fail("unsafe request sent")),
        before_request=budget,
    ) as client:
        with pytest.raises(UnsafeRequest):
            await client.get(url)
    assert not calls


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:8.8.8.8",
        "2002:0808:0808::",
        "64:ff9b::a00:1",
        "not-an-ip",
    ],
)
async def test_any_unsafe_dns_answer_blocks_entire_request(address: str) -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return [PUBLIC_IP, address]

    async with SafeHttpClient(
        [HOST],
        resolver=resolver,
        transport=httpx.MockTransport(lambda request: pytest.fail("unsafe DNS sent")),
    ) as client:
        with pytest.raises(UnsafeRequest):
            await client.get(f"https://{HOST}/x")


async def test_redirect_revalidates_dns_before_sending_second_request() -> None:
    calls = 0

    async def resolver(host: str, port: int) -> list[str]:
        nonlocal calls
        calls += 1
        return [PUBLIC_IP] if calls == 1 else ["127.0.0.1"]

    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(302, headers={"location": "/next"})

    async with SafeHttpClient(
        [HOST], transport=httpx.MockTransport(handler), resolver=resolver
    ) as client:
        with pytest.raises(UnsafeRequest):
            await client.get(f"https://{HOST}/x")
    assert len(sent) == 1


@pytest.mark.parametrize("target", ["/next", "https://other.example/next"])
async def test_redirect_drops_all_credentials_and_does_not_replay_cookies(target: str) -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if len(sent) == 1:
            return httpx.Response(
                302, headers={"location": target, "set-cookie": "session=private"}
            )
        return httpx.Response(200, json={"ok": True})

    async with SafeHttpClient(
        [HOST, "other.example"],
        credential_host=HOST,
        credential_headers={"X-Api-Key": "fixture-key", "Authorization": "Bearer fixture-key"},
        transport=httpx.MockTransport(handler),
    ) as client:
        response = await client.get(f"https://{HOST}/x")
    assert response.json() == {"ok": True}
    assert sent[0].headers["x-api-key"] == "fixture-key"
    assert all(name not in sent[1].headers for name in ("x-api-key", "authorization", "cookie"))
    assert sent[1].headers["host"] == sent[1].url.host


@pytest.mark.parametrize(
    ("url", "robots"),
    [
        (f"https://{HOST}/robots.txt", False),
        (f"https://{HOST}/%72obots.txt", False),
        (f"https://{HOST}/anything", True),
        (f"http://{HOST}/x", False),
        ("https://other.example/x", False),
    ],
)
async def test_robots_http_and_other_hosts_never_receive_credentials(
    url: str, robots: bool
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200)

    async with SafeHttpClient(
        [HOST, "other.example"],
        credential_host=HOST,
        credential_headers={"Authorization": "Bearer fixture-key"},
        transport=httpx.MockTransport(handler),
    ) as client:
        await client.get(url, robots=robots)


async def test_budget_rejection_propagates_without_transport_call() -> None:
    class BudgetExceeded(Exception):
        pass

    async def budget(request: httpx.Request) -> None:
        raise BudgetExceeded

    async with SafeHttpClient(
        [HOST],
        before_request=budget,
        transport=httpx.MockTransport(lambda request: pytest.fail("unreserved request sent")),
    ) as client:
        with pytest.raises(BudgetExceeded):
            await client.get(f"https://{HOST}/x")


async def test_every_retry_and_redirect_reserves_budget() -> None:
    reservations: list[str] = []
    statuses = [302, 429, 503, 200]

    async def budget(request: httpx.Request) -> None:
        reservations.append(request.url.path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(statuses.pop(0), headers={"location": "/next", "retry-after": "0"})

    async with SafeHttpClient(
        [HOST],
        before_request=budget,
        limits=HttpLimits(max_retries=2),
        transport=httpx.MockTransport(handler),
    ) as client:
        assert (await client.get(f"https://{HOST}/x")).status_code == 200
    assert reservations == ["/x", "/next", "/next", "/next"]


async def test_retry_and_redirect_limits_are_finite() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, headers={"retry-after": "0"})

    async with SafeHttpClient([HOST], transport=httpx.MockTransport(handler)) as client:
        assert (await client.get(f"https://{HOST}/x")).status_code == 503
    assert calls == 2
    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(max_redirects=1),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(302, headers={"location": "/x"})
        ),
    ) as client:
        with pytest.raises(httpx.TooManyRedirects):
            await client.get(f"https://{HOST}/x")


@pytest.mark.parametrize("status", [302, 307, 429, 503])
async def test_post_body_is_never_replayed(status: int) -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(status, headers={"location": "/next", "retry-after": "0"})

    async with SafeHttpClient([HOST], transport=httpx.MockTransport(handler)) as client:
        assert (
            await client.post(f"https://{HOST}/x", json={"query": "fixture"})
        ).status_code == status
    assert len(sent) == 1


@pytest.mark.parametrize("value", ["99999999", "NaN", "Infinity", "-1", "invalid", "2.5"])
async def test_invalid_or_excessive_retry_after_does_not_retry(value: str) -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(429, headers={"retry-after": value})

    async with SafeHttpClient([HOST], transport=httpx.MockTransport(handler)) as client:
        assert (await client.get(f"https://{HOST}/x")).status_code == 429
    assert len(sent) == 1


def test_http_date_retry_after_is_bounded() -> None:
    assert _retry_delay(format_datetime(datetime.now(UTC) - timedelta(seconds=2)), 2) == 0
    assert _retry_delay(format_datetime(datetime.now(UTC) + timedelta(hours=1)), 2) is None
    assert _retry_delay("0", 2) == 0
    assert _retry_delay(None, 2) == 0.25


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], delay: float = 0) -> None:
        self.chunks = chunks
        self.delay = delay
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize("encoding", ["identity", "gzip", "deflate"])
async def test_response_is_decoded_with_bounded_size_and_closed(encoding: str) -> None:
    payload = b"fixture content"
    wire = {"identity": payload, "gzip": gzip.compress(payload), "deflate": zlib.compress(payload)}[
        encoding
    ]
    stream = Chunks([wire[:4], wire[4:]])
    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(max_response_bytes=100),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-encoding": encoding},
                stream=stream,
            )
        ),
    ) as client:
        assert (await client.get(f"https://{HOST}/x")).content == payload
    assert stream.closed


@pytest.mark.parametrize("compressed", [False, True])
async def test_wire_and_inflated_response_limits_close_stream(compressed: bool) -> None:
    payload = b"x" * 10_000
    stream = Chunks([gzip.compress(payload)] if compressed else [payload[:90], payload[90:]])
    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(max_response_bytes=100),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-encoding": "gzip" if compressed else "identity"},
                stream=stream,
            )
        ),
    ) as client:
        with pytest.raises(ResponseTooLarge):
            await client.get(f"https://{HOST}/x")
    assert stream.closed


@pytest.mark.parametrize(
    "headers",
    [
        {"content-length": "9999999"},
        {"content-length": "invalid"},
        {"content-length": "-1"},
        {"content-encoding": "br"},
        {"content-encoding": "gzip"},
    ],
)
async def test_bad_length_or_encoding_closes_stream(headers: dict[str, str]) -> None:
    stream = Chunks([b"invalid"])
    async with SafeHttpClient(
        [HOST],
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, headers=headers, stream=stream)
        ),
    ) as client:
        with pytest.raises((UnsafeRequest, ResponseTooLarge)):
            await client.get(f"https://{HOST}/x")
    assert stream.closed


async def test_deadline_includes_streaming_and_releases_concurrency_slot() -> None:
    streams: list[Chunks] = []

    def handler(request: httpx.Request) -> httpx.Response:
        stream = Chunks([b"x"], delay=1 if not streams else 0)
        streams.append(stream)
        return httpx.Response(200, stream=stream)

    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(deadline_seconds=0.03, max_concurrency=1),
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(httpx.TimeoutException):
            await client.get(f"https://{HOST}/x")
        assert (await client.get(f"https://{HOST}/x")).content == b"x"
    assert all(stream.closed for stream in streams)


async def test_cancellation_closes_stream_and_is_not_swallowed() -> None:
    stream = Chunks([b"x"], delay=10)
    async with SafeHttpClient(
        [HOST],
        transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=stream)),
    ) as client:
        task = asyncio.create_task(client.get(f"https://{HOST}/x"))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert stream.closed


async def test_client_concurrency_bound_applies_to_entire_read() -> None:
    active = 0
    maximum = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200)

    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(max_concurrency=2),
        transport=httpx.MockTransport(handler),
    ) as client:
        await asyncio.gather(*(client.get(f"https://{HOST}/x") for _ in range(7)))
    assert maximum == 2


class RecordingStream(httpcore.AsyncMockStream):
    def __init__(self) -> None:
        super().__init__([b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"])
        self.sni: str | None = None
        self.writes: list[bytes] = []
        self.closed = False

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self.writes.append(buffer)
        await super().write(buffer, timeout)

    async def start_tls(
        self,
        ssl_context: ssl.SSLContext,
        server_hostname: str | None = None,
        timeout: float | None = None,
    ) -> httpcore.AsyncNetworkStream:
        assert ssl_context.check_hostname
        assert ssl_context.verify_mode == ssl.CERT_REQUIRED
        self.sni = server_hostname
        return self

    async def aclose(self) -> None:
        self.closed = True
        await super().aclose()


async def test_real_httpcore_connects_only_pinned_ip_with_original_tls_sni_and_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connections: list[tuple[str, int]] = []
    stream = RecordingStream()

    async def connect(
        self: Any,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        connections.append((host, port))
        return stream

    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", connect)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
    dns_calls = 0

    async def resolver(host: str, port: int) -> list[str]:
        nonlocal dns_calls
        dns_calls += 1
        return [PUBLIC_IP] if dns_calls == 1 else ["127.0.0.1"]

    async with SafeHttpClient([HOST], resolver=resolver) as client:
        assert (await client.get(f"https://{HOST}/x")).text == "ok"
    assert connections == [(PUBLIC_IP, 443)]
    assert dns_calls == 1
    assert stream.sni == HOST
    assert b"host: catalog.example\r\n" in b"".join(stream.writes).lower()
    assert stream.closed


async def test_pinned_backend_rejects_private_ip_even_if_called_directly() -> None:
    with pytest.raises(UnsafeRequest):
        _PinnedBackend("127.0.0.1")


async def test_public_literal_resolver_does_not_query_dns() -> None:
    assert await resolve_public_addresses(PUBLIC_IP, 443) == [PUBLIC_IP]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"deadline_seconds": 0},
        {"io_timeout_seconds": float("inf")},
        {"max_response_bytes": 0},
        {"max_concurrency": 0},
        {"max_redirects": -1},
        {"max_retries": -1},
        {"max_retry_after_seconds": float("nan")},
    ],
)
def test_invalid_limits_fail_at_configuration(kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        HttpLimits(**kwargs)


async def test_nonpublic_headers_and_oversize_body_are_rejected_before_sending() -> None:
    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(max_request_bytes=2),
        transport=httpx.MockTransport(lambda request: pytest.fail("invalid input sent")),
    ) as client:
        with pytest.raises(UnsafeRequest):
            await client.get(f"https://{HOST}/x", headers={"Authorization": "secret"})
        with pytest.raises(ResponseTooLarge):
            await client.post(f"https://{HOST}/x", content=b"long")
        with pytest.raises(UnsafeRequest):
            await client.get(f"https://{HOST}/x", content=b"x")
        with pytest.raises(UnsafeRequest):
            await client.request("CONNECT", f"https://{HOST}/x")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"credential_headers": {"X-Key": "value"}},
        {"credential_host": "other.example"},
        {"credential_host": HOST, "credential_headers": {"Host": "other.example"}},
    ],
)
def test_credential_configuration_requires_separate_allowed_host(kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        SafeHttpClient([HOST], **kwargs)


async def test_deadline_includes_dns_and_retry_after_wait() -> None:
    async def slow_resolver(host: str, port: int) -> list[str]:
        await asyncio.sleep(1)
        return [PUBLIC_IP]

    async with SafeHttpClient(
        [HOST],
        resolver=slow_resolver,
        limits=HttpLimits(deadline_seconds=0.02),
        transport=httpx.MockTransport(lambda request: pytest.fail("deadline DNS sent")),
    ) as client:
        with pytest.raises(httpx.TimeoutException):
            await client.get(f"https://{HOST}/x")
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(429, headers={"retry-after": "1"})

    async with SafeHttpClient(
        [HOST],
        limits=HttpLimits(deadline_seconds=0.02),
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(httpx.TimeoutException):
            await client.get(f"https://{HOST}/x")
    assert len(sent) == 1


async def test_os_dns_results_are_observed_without_real_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def answer(*args: Any, **kwargs: Any) -> list[Any]:
        return [
            (2, 1, 6, "", (PUBLIC_IP, 443)),
            (10, 1, 6, "", ("2606:4700:4700::1111", 443, 0, 0)),
        ]

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "getaddrinfo", answer)
    assert await resolve_public_addresses(HOST, 443) == [PUBLIC_IP, "2606:4700:4700::1111"]

    async def failure(*args: Any, **kwargs: Any) -> list[Any]:
        raise OSError("fixture DNS failure")

    monkeypatch.setattr(loop, "getaddrinfo", failure)
    with pytest.raises(httpx.ConnectError, match="DNS lookup failed"):
        await resolve_public_addresses(HOST, 443)


async def test_empty_dns_response_never_sends() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return []

    async with SafeHttpClient(
        [HOST],
        resolver=resolver,
        transport=httpx.MockTransport(lambda request: pytest.fail("empty DNS sent")),
    ) as client:
        with pytest.raises(UnsafeRequest):
            await client.get(f"https://{HOST}/x")


@pytest.mark.parametrize("error", [httpcore.ConnectTimeout, httpcore.ConnectError])
async def test_core_connection_failure_is_httpx_compatible_and_not_retried(
    monkeypatch: pytest.MonkeyPatch,
    error: type[Exception],
) -> None:
    attempts = 0

    async def failure(*args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        nonlocal attempts
        attempts += 1
        raise error("fixture connection failure")

    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", failure)
    async with SafeHttpClient([HOST], resolver=public_dns) as client:
        with pytest.raises(httpx.RequestError):
            await client.get(f"https://{HOST}/x")
    assert attempts == 1


async def test_bad_tls_certificate_cannot_produce_success(monkeypatch: pytest.MonkeyPatch) -> None:
    class InvalidTLS(RecordingStream):
        async def start_tls(
            self,
            ssl_context: ssl.SSLContext,
            server_hostname: str | None = None,
            timeout: float | None = None,
        ) -> httpcore.AsyncNetworkStream:
            assert ssl_context.check_hostname
            assert ssl_context.verify_mode == ssl.CERT_REQUIRED
            raise httpcore.ConnectError("certificate mismatch")

    stream = InvalidTLS()

    async def connect(*args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        return stream

    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", connect)
    async with SafeHttpClient([HOST], resolver=public_dns) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(f"https://{HOST}/x")
    assert not stream.writes


@pytest.mark.parametrize("location", ["/next?key=fixture-secret", "/next?key=fixture%2Dsecret"])
async def test_redirect_cannot_replay_credential_value_in_url(location: str) -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(302, headers={"location": location})

    async with SafeHttpClient(
        [HOST],
        credential_host=HOST,
        credential_headers={"Authorization": "Bearer fixture-secret"},
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(UnsafeRequest):
            await client.get(f"https://{HOST}/x")
    assert len(sent) == 1


async def test_separate_clients_share_worker_outbound_concurrency_limit() -> None:
    active = maximum = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        active -= 1
        return httpx.Response(200, text="ok")

    async def fetch_one() -> None:
        async with SafeHttpClient(
            ["example.com"], transport=httpx.MockTransport(handler)
        ) as client:
            assert (await client.get("https://example.com/")).status_code == 200

    await asyncio.gather(*(fetch_one() for _ in range(12)))
    assert maximum == 4
    assert active == 0


async def test_waiting_request_rechecks_cancellation_without_repeating_reservation() -> None:
    from sooljang.infrastructure.external.request_guard import outbound_guard

    all_busy = asyncio.Event()
    release = asyncio.Event()
    reserved = asyncio.Event()
    sent: list[str] = []
    reservations = 0
    disconnected = False

    async def respond(request: httpx.Request) -> httpx.Response:
        sent.append(request.url.path)
        if request.url.path == "/busy":
            if sent.count("/busy") == 4:
                all_busy.set()
            await release.wait()
        return httpx.Response(200, text="ok")

    async def occupy() -> None:
        async with SafeHttpClient([HOST], transport=httpx.MockTransport(respond)) as client:
            await client.get(f"https://{HOST}/busy")

    async def check_connection(_request: httpx.Request) -> None:
        if disconnected:
            raise asyncio.CancelledError

    async def reserve(_request: httpx.Request) -> None:
        nonlocal reservations
        reservations += 1
        reserved.set()

    busy = [asyncio.create_task(occupy()) for _ in range(4)]
    try:
        await asyncio.wait_for(all_busy.wait(), 2)
        async with SafeHttpClient(
            [HOST], transport=httpx.MockTransport(respond), before_request=reserve
        ) as client:
            with outbound_guard(check_connection):
                waiting = asyncio.create_task(client.get(f"https://{HOST}/paid"))
                await asyncio.wait_for(reserved.wait(), 2)
                disconnected = True
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await waiting
            assert reservations == 1
            assert sent == ["/busy"] * 4
            # 취소된 작업의 가드는 다음 독립 요청에 남지 않는다.
            assert (await client.get(f"https://{HOST}/next")).status_code == 200
            assert reservations == 2
    finally:
        release.set()
        await asyncio.gather(*busy)
