"""제공자 등록 계약과 제한된 비생성 연결 확인 요청.

검색 결과 취득·매칭은 별도 소비자가 구현한다. 이 모듈의 성공은 지정 endpoint 인증/응답
형식 확인만 뜻하며 모델 추론·가격 원문 권리·계정 잔액을 검증한 결과가 아니다.
"""

from dataclasses import dataclass
from typing import Any

import httpx

from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.external.safe_http import (
    BeforeRequest,
    HttpLimits,
    SafeHttpClient,
    UnsafeRequest,
)


@dataclass(frozen=True, slots=True)
class CredentialField:
    name: str
    label: str


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    kind: str
    label: str
    fields: tuple[CredentialField, ...]
    features: tuple[str, ...]
    guide_url: str
    note: str
    probe_supported: bool = True


PROVIDERS: tuple[ProviderDefinition, ...] = (
    ProviderDefinition(
        "naver_hub",
        "네이버 API HUB",
        (
            CredentialField("client_id", "Client ID"),
            CredentialField("client_secret", "Client Secret"),
        ),
        ("블로그 검색", "웹 문서 검색", "카페글 검색"),
        "https://guide.ncloud-docs.com/docs/apihub-application",
        "네이버 클라우드 API HUB 인증 정보를 사용합니다. 쇼핑 상품 검색은 종료되었습니다.",
    ),
    ProviderDefinition(
        "naver_legacy",
        "네이버 기존 개발자센터",
        (
            CredentialField("client_id", "Client ID"),
            CredentialField("client_secret", "Client Secret"),
        ),
        ("블로그 검색", "웹 문서 검색", "카페글 검색"),
        "https://developers.naver.com/notice/article/32530",
        "기존 이용자만 2027년 6월까지 사용하는 연결입니다. API HUB 키와 호환되지 않습니다.",
    ),
    ProviderDefinition(
        "brave",
        "Brave Search",
        (CredentialField("api_key", "API 키"),),
        ("웹 검색",),
        "https://api-dashboard.search.brave.com/",
        "요금이 발생할 수 있습니다. 결과 보관에는 저장 권리를 포함한 계약이 필요합니다.",
    ),
    ProviderDefinition(
        "exa",
        "Exa Search",
        (CredentialField("api_key", "API 키"),),
        ("웹 검색",),
        "https://dashboard.exa.ai/",
        "일반 검색만 사용합니다. 답변·요약·Research 생성 기능은 호출하지 않습니다.",
    ),
    ProviderDefinition(
        "openai_ocr",
        "OpenAI · 라벨 인식",
        (CredentialField("api_key", "OpenAI API 키"),),
        ("라벨 사진 인식", "선택형 AI 매칭 보조"),
        "https://platform.openai.com/api-keys",
        "모델 목록으로 인증만 확인합니다. 라벨 인식 권한·잔액은 별도이며 검색에는 필요 없습니다.",
    ),
    ProviderDefinition(
        "dailyshot",
        "데일리샷",
        (),
        ("제품 정보", "판매 후보"),
        "https://dailyshot.co/",
        "키는 필요하지 않습니다. 공개 접근과 자료 재사용 허용·판매 조건은 따로 확인합니다.",
    ),
    ProviderDefinition(
        "source",
        "기존·직접 등록 소스",
        (),
        ("제품 정보",),
        "https://dailyshot.co/",
        "기존 소스와 파싱 설정을 보존합니다. 필요한 인증 항목은 해당 소스 설정을 따릅니다.",
        probe_supported=False,
    ),
)
PROVIDER_BY_KIND = {entry.kind: entry for entry in PROVIDERS}


def provider_definition(kind: str) -> ProviderDefinition:
    try:
        return PROVIDER_BY_KIND[kind]
    except KeyError:
        raise ValueError("지원하지 않는 연결 제공자입니다") from None


@dataclass(frozen=True, repr=False)
class ProviderRequest:
    method: str
    url: str
    headers: dict[str, str]
    params: dict[str, str] | None = None
    body: dict[str, Any] | None = None


def build_test_request(kind: str, credentials: dict[str, str]) -> ProviderRequest:
    """공개 고정 검색어의 최소 요청. 임의 endpoint·query·생성 옵션을 받지 않는다."""
    if kind in {"naver_hub", "naver_legacy"}:
        if kind == "naver_hub":
            url = "https://naverapihub.apigw.ntruss.com/search/v1/webkr"
            headers = {
                "X-NCP-APIGW-API-KEY-ID": credentials["client_id"],
                "X-NCP-APIGW-API-KEY": credentials["client_secret"],
            }
        else:
            url = "https://openapi.naver.com/v1/search/webkr.json"
            headers = {
                "X-Naver-Client-Id": credentials["client_id"],
                "X-Naver-Client-Secret": credentials["client_secret"],
            }
        return ProviderRequest("GET", url, headers, {"query": "위스키", "display": "1"})
    if kind == "brave":
        return ProviderRequest(
            "GET",
            "https://api.search.brave.com/res/v1/web/search",
            {"X-Subscription-Token": credentials["api_key"]},
            {"q": "whisky", "count": "1", "result_filter": "web"},
        )
    if kind == "exa":
        return ProviderRequest(
            "POST",
            "https://api.exa.ai/search",
            {"x-api-key": credentials["api_key"]},
            body={"query": "whisky", "type": "fast", "numResults": 1},
        )
    if kind == "openai_ocr":
        return ProviderRequest(
            "GET",
            "https://api.openai.com/v1/models",
            {"Authorization": f"Bearer {credentials['api_key']}"},
        )
    if kind == "dailyshot":
        return ProviderRequest("GET", "https://api.dailyshot.co/items/search/", {}, {"q": "whisky"})
    raise ValueError("이 소스의 연결 확인은 원문 소스 테스트를 이용하세요")


def _response_outcome(kind: str, response: httpx.Response) -> SourceOutcome:
    if response.status_code == 401:
        return SourceOutcome.AUTHENTICATION_FAILED
    if response.status_code == 403:
        return SourceOutcome.FORBIDDEN
    if response.status_code == 429:
        return SourceOutcome.RATE_LIMITED
    if response.status_code >= 500:
        return SourceOutcome.NETWORK_ERROR
    if response.status_code != 200:
        return SourceOutcome.INVALID_CONFIGURATION
    try:
        body = response.json()
        if not isinstance(body, dict):
            return SourceOutcome.PARSE_ERROR
        if kind == "brave":
            # 검색 결과가 0개면 web 객체가 없을 수 있지만 query/type은 있어야 한다.
            valid = body.get("type") == "search" and isinstance(body.get("query"), dict)
        else:
            field = (
                "items"
                if kind.startswith("naver_")
                else "data"
                if kind == "openai_ocr"
                else "results"
            )
            valid = isinstance(body.get(field), list)
        return SourceOutcome.SUCCESS if valid else SourceOutcome.PARSE_ERROR
    except ValueError, TypeError:
        return SourceOutcome.PARSE_ERROR


async def test_provider_connection(
    kind: str,
    credentials: dict[str, str],
    *,
    before_request: BeforeRequest,
    transport: httpx.AsyncBaseTransport | None = None,
) -> SourceOutcome:
    """SafeHttpClient에서 고정된 endpoint만 확인하고 응답 본문은 저장/반환하지 않는다."""
    request = build_test_request(kind, credentials)
    host = httpx.URL(request.url).host
    try:
        async with SafeHttpClient(
            [host],
            credential_host=host,
            credential_headers=request.headers,
            before_request=before_request,
            transport=transport,
            limits=HttpLimits(max_retries=0, max_redirects=0),
        ) as client:
            # Dailyshot은 일반 공개 수집 경로이므로 robots를 먼저 확인한다.
            if kind == "dailyshot":
                from urllib.robotparser import RobotFileParser

                robots = await client.get(
                    f"https://{host}/robots.txt", robots=True, send_credentials=False
                )
                if robots.status_code not in {200, 404}:
                    return SourceOutcome.POLICY_BLOCKED
                if robots.status_code == 200:
                    policy = RobotFileParser()
                    policy.parse(robots.text.splitlines())
                    if not policy.can_fetch("SoolJang", request.url):
                        return SourceOutcome.POLICY_BLOCKED
            response = await client.request(
                request.method,
                request.url,
                params=request.params,
                json=request.body,
                headers={"accept": "application/json"},
            )
            # 잘못된 API가 키를 반사해도 외부 본문을 로그/응답으로 돌려보내지 않는다.
            if any(value and value in response.text for value in credentials.values()):
                return SourceOutcome.PARSE_ERROR
            return _response_outcome(kind, response)
    except UnsafeRequest, httpx.TooManyRedirects:
        return SourceOutcome.POLICY_BLOCKED
    except httpx.HTTPError, TimeoutError:
        return SourceOutcome.NETWORK_ERROR
