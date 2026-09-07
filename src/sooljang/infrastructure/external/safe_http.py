"""외부 요청의 URL·DNS·비밀·자원 한도를 한 경계에서 강제한다.

httpcore의 공개 network backend로 검증한 IP에만 연결한다. HTTP origin은 바꾸지
않으므로 Host와 TLS 인증서/SNI는 원래 hostname을 사용한다. 환경 proxy, cookie jar,
자동 redirect와 transport retry는 사용하지 않는다. 테스트용 transport/resolver 주입은
신뢰하는 애플리케이션 코드에만 허용하며 사용자 설정으로 노출하지 않는다.
"""

import asyncio
import ipaddress
import math
import re
import socket
import ssl
import weakref
import zlib
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from types import TracebackType
from typing import Any, Self, cast
from urllib.parse import unquote

import httpcore
import httpx

Resolver = Callable[[str, int], Awaitable[Sequence[str]]]
BeforeRequest = Callable[[httpx.Request], Awaitable[None]]
_PUBLIC_HEADERS = frozenset(
    {"accept", "accept-language", "content-type", "user-agent", "x-requested-with"}
)
_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_REDIRECTS = frozenset({301, 302, 303, 307, 308})
_PROCESS_LIMIT = 4
_LOOP_LIMITERS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def _outbound_limiter() -> asyncio.Semaphore:
    """여러 조회가 각각 client를 만들어도 worker의 실제 동시 송신은 제한한다."""
    loop = asyncio.get_running_loop()
    if loop not in _LOOP_LIMITERS:
        _LOOP_LIMITERS[loop] = asyncio.Semaphore(_PROCESS_LIMIT)
    return _LOOP_LIMITERS[loop]


class UnsafeRequest(httpx.RequestError):
    """허용된 외부 대상/비밀 전달 계약에 맞지 않는 요청."""


class ResponseTooLarge(httpx.RequestError):
    """압축 전후 응답 또는 요청 본문 한도 초과."""


@dataclass(frozen=True)
class HttpLimits:
    """모든 hop, 재시도와 대기시간을 포함하는 요청당 상한."""

    deadline_seconds: float = 15.0
    io_timeout_seconds: float = 5.0
    max_response_bytes: int = 2_000_000
    max_request_bytes: int = 100_000
    max_redirects: int = 3
    max_retries: int = 1
    max_retry_after_seconds: float = 2.0
    max_concurrency: int = 4

    def __post_init__(self) -> None:
        for value in (self.deadline_seconds, self.io_timeout_seconds):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("HTTP timeout must be finite and positive")
        if not math.isfinite(self.max_retry_after_seconds) or self.max_retry_after_seconds < 0:
            raise ValueError("Retry-After limit must be finite and nonnegative")
        if min(self.max_response_bytes, self.max_request_bytes, self.max_concurrency) <= 0:
            raise ValueError("HTTP size and concurrency limits must be positive")
        if min(self.max_redirects, self.max_retries) < 0:
            raise ValueError("HTTP redirect and retry limits must be nonnegative")


def _public_ip(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise UnsafeRequest("Invalid DNS address") from None
    # IPv4 transition mechanisms can route a globally shaped IPv6 address to a private IPv4.
    if (
        not address.is_global
        or address.is_multicast
        or address.is_reserved
        or "%" in value
        or (
            isinstance(address, ipaddress.IPv6Address)
            and (
                address.ipv4_mapped is not None
                or address.sixtofour is not None
                or address.teredo is not None
                or address in ipaddress.ip_network("64:ff9b::/96")
            )
        )
    ):
        raise UnsafeRequest("Non-public network destination")
    return str(address)


def _host(value: str) -> str:
    try:
        host = value.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise UnsafeRequest("Invalid hostname") from None
    if not host or host.endswith(".") or "%" in host or len(host) > 253:
        raise UnsafeRequest("Invalid hostname")
    try:
        return _public_ip(host)
    except UnsafeRequest:
        # A syntactic IP must not fall back to a DNS hostname.
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise
    if ":" in host or "." not in host or not all(_HOST_LABEL.fullmatch(p) for p in host.split(".")):
        raise UnsafeRequest("Invalid hostname")
    return host


def validate_url(url: str | httpx.URL, allowed_hosts: frozenset[str]) -> httpx.URL:
    """명시한 host와 기본 HTTP(S) port만 허용한다. 오류에 원문 URL을 남기지 않는다."""
    raw = str(url)
    if "\\" in raw or any(ord(char) <= 32 or ord(char) == 127 for char in raw):
        raise UnsafeRequest("Invalid URL characters")
    try:
        parsed = httpx.URL(raw)
    except httpx.InvalidURL, ValueError:
        raise UnsafeRequest("Invalid URL") from None
    if parsed.scheme not in {"http", "https"} or not parsed.host or parsed.userinfo:
        raise UnsafeRequest("Only HTTP(S) URLs without userinfo are allowed")
    host = _host(parsed.host)
    if host not in allowed_hosts or parsed.port not in {
        None,
        80 if parsed.scheme == "http" else 443,
    }:
        raise UnsafeRequest("Host or port is not allowed")
    return parsed.copy_with(fragment=None)


async def resolve_public_addresses(host: str, port: int) -> Sequence[str]:
    """OS DNS를 한 번 조회한다. 연결에는 hostname 대신 검증된 결과만 넘긴다."""
    try:
        return [_public_ip(host)]
    except UnsafeRequest:
        pass
    try:
        results = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise httpx.ConnectError("DNS lookup failed") from None
    return [str(result[4][0]) for result in results]


class _PinnedBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, address: str, backend: httpcore.AsyncNetworkBackend | None = None) -> None:
        self.address = _public_ip(address)
        self.backend = backend or cast(httpcore.AsyncNetworkBackend, httpcore.AnyIOBackend())

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        return await self.backend.connect_tcp(
            self.address, port, timeout, local_address, socket_options
        )


class _CoreStream(httpx.AsyncByteStream):
    def __init__(self, response: httpcore.Response, pool: httpcore.AsyncConnectionPool) -> None:
        self.response = response
        self.pool = pool

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for part in self.response.aiter_stream():
                yield part
        except httpcore.TimeoutException:
            raise httpx.ReadTimeout("External response timed out") from None
        except httpcore.NetworkError, httpcore.ProtocolError:
            raise httpx.ReadError("External response failed") from None

    async def aclose(self) -> None:
        try:
            await self.response.aclose()
        finally:
            await self.pool.aclose()


class _PinnedTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # Each request owns its pool: no connection can be reused under a different DNS pin.
        address = str(request.extensions["sooljang_pinned_ip"])
        pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl.create_default_context(),
            network_backend=_PinnedBackend(address),
            max_connections=1,
            max_keepalive_connections=0,
            retries=0,
        )
        try:
            response = await pool.handle_async_request(
                httpcore.Request(
                    method=request.method,
                    url=httpcore.URL(
                        scheme=request.url.raw_scheme,
                        host=request.url.raw_host,
                        port=request.url.port,
                        target=request.url.raw_path,
                    ),
                    headers=request.headers.raw,
                    content=request.content,
                    extensions={"timeout": request.extensions["timeout"]},
                )
            )
            return httpx.Response(
                response.status,
                headers=response.headers,
                stream=_CoreStream(response, pool),
                request=request,
            )
        except BaseException as exc:
            await pool.aclose()
            if isinstance(exc, httpcore.TimeoutException):
                raise httpx.ConnectTimeout("External request timed out") from None
            if isinstance(exc, (httpcore.NetworkError, httpcore.ProtocolError)):
                raise httpx.ConnectError("External connection failed") from None
            raise


async def _read_response(response: httpx.Response, limit: int) -> httpx.Response:
    encoding = response.headers.get("content-encoding", "identity").strip().lower()
    if encoding not in {"identity", "gzip", "deflate"}:
        raise UnsafeRequest("Unsupported response encoding")
    declared = response.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
        except ValueError:
            raise UnsafeRequest("Invalid response length") from None
        if length < 0:
            raise UnsafeRequest("Invalid response length")
        if length > limit:
            raise ResponseTooLarge("External response exceeds byte limit")
    decoder = (
        None if encoding == "identity" else zlib.decompressobj(31 if encoding == "gzip" else 15)
    )
    wire_size = 0
    body = bytearray()
    assert isinstance(response.stream, httpx.AsyncByteStream)
    try:
        async for chunk in response.stream:
            wire_size += len(chunk)
            if wire_size > limit:
                raise ResponseTooLarge("External response exceeds byte limit")
            decoded = chunk if decoder is None else decoder.decompress(chunk, limit - len(body) + 1)
            body.extend(decoded)
            if len(body) > limit or (decoder is not None and decoder.unconsumed_tail):
                raise ResponseTooLarge("Decoded response exceeds byte limit")
        if decoder is not None and (not decoder.eof or decoder.unused_data):
            raise UnsafeRequest("Invalid or concatenated compressed response")
    except zlib.error:
        raise UnsafeRequest("Invalid compressed response") from None
    headers = response.headers.copy()
    headers.pop("content-encoding", None)
    headers.pop("content-length", None)
    return httpx.Response(
        response.status_code, headers=headers, content=bytes(body), request=response.request
    )


def _retry_delay(value: str | None, maximum: float) -> float | None:
    if value is None:
        return min(0.25, maximum)
    try:
        if value.isascii() and value.isdigit():
            seconds = float(value)
        else:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                return None
            seconds = max(0.0, (date - datetime.now(UTC)).total_seconds())
    except ValueError, TypeError, OverflowError:
        return None
    # Do not sleep the capped duration and then violate a longer server-requested wait.
    return seconds if math.isfinite(seconds) and 0 <= seconds <= maximum else None


class SafeHttpClient:
    """Bounded HTTPX response API; 비밀 헤더는 HTTPS 최초 hop의 지정 host만 받는다.

    before_request는 DNS/URL 검증 뒤 실제 요청마다(robots/redirect/retry 포함) 호출한다.
    callback 예외는 요청을 중단한다. 지속 비용 예산은 이 callback에서 원자적으로 예약한다.
    리다이렉트에는 본문과 비밀을 전달하지 않기 위해 GET/HEAD만 자동 추적한다.
    """

    def __init__(
        self,
        allowed_hosts: Iterable[str],
        *,
        credential_host: str | None = None,
        credential_headers: Mapping[str, str] | None = None,
        before_request: BeforeRequest | None = None,
        limits: HttpLimits | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        resolver: Resolver = resolve_public_addresses,
    ) -> None:
        self.allowed_hosts = frozenset(_host(host) for host in allowed_hosts)
        self.credential_host = _host(credential_host) if credential_host else None
        if self.credential_host and self.credential_host not in self.allowed_hosts:
            raise ValueError("Credential host must be an explicitly allowed host")
        if credential_headers and not self.credential_host:
            raise ValueError("Credential headers require an explicit credential host")
        self._credentials = httpx.Headers(credential_headers or {})
        if any(key in {"host", "content-length", "transfer-encoding"} for key in self._credentials):
            raise ValueError("Credentials cannot override HTTP routing or framing")
        self.limits = limits or HttpLimits()
        self.before_request = before_request
        self._resolver = resolver
        self._mock_dns = (
            isinstance(transport, httpx.MockTransport) and resolver is resolve_public_addresses
        )
        self._transport = transport or _PinnedTransport()
        self._semaphore = asyncio.Semaphore(self.limits.max_concurrency)

    async def __aenter__(self) -> Self:
        await self._transport.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self._transport.__aexit__(exc_type, exc_value, traceback)

    async def get(self, url: str | httpx.URL, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str | httpx.URL, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def request(
        self,
        method: str,
        url: str | httpx.URL,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        content: bytes | None = None,
        json: Any = None,
        robots: bool = False,
        send_credentials: bool = True,
    ) -> httpx.Response:
        if method.upper() not in {"GET", "HEAD", "POST"}:
            raise UnsafeRequest("Unsupported external request method")
        public_headers = httpx.Headers(headers or {})
        if any(key not in _PUBLIC_HEADERS for key in public_headers):
            raise UnsafeRequest("Use credential_headers for non-public headers")
        parsed = validate_url(url, self.allowed_hosts)
        if params:
            parsed = parsed.copy_merge_params(params)
        initial = httpx.Request(method, parsed, headers=public_headers, content=content, json=json)
        if initial.method in {"GET", "HEAD"} and initial.content:
            raise UnsafeRequest("GET and HEAD cannot carry a request body")
        if len(initial.content) > self.limits.max_request_bytes:
            raise ResponseTooLarge("External request exceeds byte limit")
        try:
            async with asyncio.timeout(self.limits.deadline_seconds), self._semaphore:
                return await self._request(initial, robots, send_credentials)
        except TimeoutError:
            raise httpx.TimeoutException("External request deadline exceeded") from None

    async def _request(
        self, initial: httpx.Request, robots: bool, send_credentials: bool
    ) -> httpx.Response:
        url = initial.url
        redirects = 0
        retries = 0
        while True:
            url = validate_url(url, self.allowed_hosts)
            addresses = (
                ["93.184.216.34"]
                if self._mock_dns
                else await self._resolver(
                    url.host, url.port or (443 if url.scheme == "https" else 80)
                )
            )
            if not addresses:
                raise UnsafeRequest("DNS returned no addresses")
            # Reject the complete DNS answer if any candidate is unsafe, not just the first.
            pinned = [_public_ip(address) for address in addresses][0]
            headers = initial.headers.copy()
            headers["host"] = url.netloc.decode("ascii")
            headers["accept-encoding"] = "gzip, deflate"
            is_robots = robots or unquote(url.path).rstrip("/").lower() == "/robots.txt"
            if (
                send_credentials
                and redirects == 0
                and not is_robots
                and url.scheme == "https"
                and url.host == self.credential_host
            ):
                headers.update(self._credentials)
            request = httpx.Request(initial.method, url, headers=headers, content=initial.content)
            request.extensions = {
                "sooljang_pinned_ip": pinned,
                "sooljang_robots": is_robots,
                "timeout": dict.fromkeys(
                    ("connect", "read", "write", "pool"), self.limits.io_timeout_seconds
                ),
            }
            if self.before_request:
                await self.before_request(request)
            # preflight가 robots 요청을 할 수 있으므로 callback 이후 실제 송신만 제한한다.
            async with _outbound_limiter():
                response = await self._transport.handle_async_request(request)
                response.request = request
                try:
                    buffered = await _read_response(response, self.limits.max_response_bytes)
                finally:
                    await response.aclose()
            if buffered.status_code in _REDIRECTS and buffered.headers.get("location"):
                if initial.method not in {"GET", "HEAD"}:
                    return buffered
                if redirects >= self.limits.max_redirects:
                    raise httpx.TooManyRedirects("External redirect limit exceeded")
                try:
                    target = url.join(buffered.headers["location"])
                    secrets = list(self._credentials.values())
                    authorization = self._credentials.get("authorization", "")
                    if " " in authorization:
                        secrets.append(authorization.split(" ", 1)[1])
                    decoded_target = unquote(unquote(str(target)))
                    if any(secret and secret in decoded_target for secret in secrets):
                        raise UnsafeRequest("Redirect reflects credentials")
                    url = target
                except httpx.InvalidURL, ValueError:
                    raise UnsafeRequest("Invalid redirect URL") from None
                redirects += 1
                continue
            if buffered.status_code in {429, 503} and initial.method in {"GET", "HEAD"}:
                delay = _retry_delay(
                    buffered.headers.get("retry-after"), self.limits.max_retry_after_seconds
                )
                if retries < self.limits.max_retries and delay is not None:
                    retries += 1
                    await asyncio.sleep(delay)
                    continue
            return buffered
