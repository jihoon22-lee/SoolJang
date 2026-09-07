"""연결 확인은 고정 endpoint·인증 헤더·최소 비생성 요청만 허용한다."""

import json

import httpx
import pytest

from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.external.providers import (
    build_test_request,
)
from sooljang.infrastructure.external.providers import (
    test_provider_connection as check_connection,
)

SECRET = "synthetic-secret-value"
CREDENTIALS = {"api_key": SECRET, "client_id": "synthetic-id", "client_secret": SECRET}


@pytest.mark.parametrize(
    ("kind", "host", "method", "auth"),
    [
        ("naver_hub", "naverapihub.apigw.ntruss.com", "GET", "x-ncp-apigw-api-key"),
        ("naver_legacy", "openapi.naver.com", "GET", "x-naver-client-secret"),
        ("brave", "api.search.brave.com", "GET", "x-subscription-token"),
        ("exa", "api.exa.ai", "POST", "x-api-key"),
        ("openai_ocr", "api.openai.com", "GET", "authorization"),
    ],
)
async def test_fixed_endpoint_credentials_and_one_reservation(
    kind: str, host: str, method: str, auth: str
) -> None:
    requests: list[httpx.Request] = []
    reserved: list[httpx.Request] = []

    async def reserve(request: httpx.Request) -> None:
        reserved.append(request)

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200, json={"items": [], "results": [], "data": [], "type": "search", "query": {}}
        )

    result = await check_connection(
        kind, CREDENTIALS, before_request=reserve, transport=httpx.MockTransport(respond)
    )
    assert result == SourceOutcome.SUCCESS
    assert len(requests) == len(reserved) == 1
    request = requests[0]
    assert request.url.host == host and request.method == method
    assert SECRET in request.headers[auth]
    assert SECRET not in str(request.url)
    if kind == "exa":
        assert json.loads(request.content) == {"query": "whisky", "type": "fast", "numResults": 1}
    if kind == "openai_ocr":
        assert request.url.path == "/v1/models" and not request.content
    assert SECRET not in repr(build_test_request(kind, CREDENTIALS))


@pytest.mark.parametrize(
    ("status", "body", "outcome"),
    [
        (401, {}, SourceOutcome.AUTHENTICATION_FAILED),
        (403, {}, SourceOutcome.FORBIDDEN),
        (429, {}, SourceOutcome.RATE_LIMITED),
        (503, {}, SourceOutcome.NETWORK_ERROR),
        (404, {}, SourceOutcome.INVALID_CONFIGURATION),
        (200, [], SourceOutcome.PARSE_ERROR),
        (200, {}, SourceOutcome.PARSE_ERROR),
        (200, {"data": [], "echo": SECRET}, SourceOutcome.PARSE_ERROR),
    ],
)
async def test_error_classification_never_returns_provider_body(
    status: int, body: object, outcome: SourceOutcome
) -> None:
    async def reserve(_request: httpx.Request) -> None:
        pass

    result = await check_connection(
        "openai_ocr",
        CREDENTIALS,
        before_request=reserve,
        transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body)),
    )
    assert result == outcome
    assert SECRET not in str(result)


async def test_redirect_does_not_forward_key_or_retry() -> None:
    requests: list[httpx.Request] = []

    async def reserve(_request: httpx.Request) -> None:
        pass

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"location": "https://attacker.example/collect"})

    result = await check_connection(
        "brave", CREDENTIALS, before_request=reserve, transport=httpx.MockTransport(respond)
    )
    assert result == SourceOutcome.POLICY_BLOCKED
    assert len(requests) == 1


async def test_keyless_source_checks_robots_before_product_request() -> None:
    paths: list[str] = []

    async def reserve(_request: httpx.Request) -> None:
        pass

    def respond(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert "authorization" not in request.headers
        return httpx.Response(200, text="User-agent: *\nDisallow: /")

    result = await check_connection(
        "dailyshot", {}, before_request=reserve, transport=httpx.MockTransport(respond)
    )
    assert result == SourceOutcome.POLICY_BLOCKED
    assert paths == ["/robots.txt"]
