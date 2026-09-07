"""제공자별 비생성 검색 계약. HTTP와 순수 문서 변환을 분리하고 원문을 보관하지 않는다."""

import hashlib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup

from sooljang.domain.discovery import RequestBudgetExceeded, SourceOutcome
from sooljang.infrastructure.external.providers import ProviderRequest, build_test_request
from sooljang.infrastructure.external.safe_http import (
    BeforeRequest,
    HttpLimits,
    SafeHttpClient,
    UnsafeRequest,
)

SEARCH_KINDS = frozenset({"naver_hub", "naver_legacy", "brave", "exa"})
_SECRET_QUERY = re.compile(r"token|secret|password|api.?key|authorization|signature", re.I)


def canonical_document_url(value: Any) -> str | None:
    """추적 매개변수만 제거한다. SKU/빈티지/SPA fragment는 원문 identity다."""
    if not isinstance(value, str) or len(value) > 2000:
        return None
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        if (
            parts.scheme not in {"https", "http"}
            or not host
            or parts.username is not None
            or parts.password is not None
            or parts.port not in {None, 80, 443}
            or any(_SECRET_QUERY.search(key) for key, _ in parse_qsl(parts.query))
        ):
            return None
        # 검색 결과 URL은 자동 요청하지 않지만 사설/로컬 링크도 표시하지 않는다.
        from sooljang.infrastructure.external.safe_http import validate_url

        validate_url(value, allowed_hosts=frozenset({host}))
        query = urlencode(
            [
                (k, v)
                for k, v in parse_qsl(parts.query, keep_blank_values=True)
                if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid"}
            ]
        )
        return urlunsplit(
            (parts.scheme, parts.netloc.lower(), parts.path or "/", query, parts.fragment)
        )
    except ValueError, UnsafeRequest:
        return None


def plain_excerpt(value: Any, limit: int = 500) -> str:
    if not isinstance(value, str):
        return ""
    soup = BeautifulSoup(value[:20_000], "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return " ".join(soup.get_text(" ").split())[:limit]


@dataclass
class SearchDocument:
    id: str
    url: str
    domain: str
    title: str
    excerpt: str
    fetched_at: datetime
    published_at: str | None = None
    evidence: str = "search_excerpt"
    kind: str = "unknown"
    discovered_by: list[str] = field(default_factory=list)
    rating: str | None = None
    rating_scale: str | None = None
    rating_count: int | None = None


@dataclass
class SearchResult:
    outcome: SourceOutcome
    documents: list[SearchDocument] = field(default_factory=list)
    warning: str | None = None
    requests: int = 0


def build_search_requests(
    kind: str, credentials: dict[str, str], *, query: str, page: int = 1, language: str = "ko"
) -> list[ProviderRequest]:
    if kind not in SEARCH_KINDS or not 1 <= page <= 3 or not query.strip() or len(query) > 300:
        raise ValueError("검색 제공자·검색명·페이지를 확인하세요")
    base = build_test_request(kind, credentials)
    if kind.startswith("naver_"):
        return [
            ProviderRequest(
                "GET",
                base.url.replace("webkr", vertical),
                base.headers,
                {"query": query, "display": "10", "start": str((page - 1) * 10 + 1)},
            )
            for vertical in ("webkr", "blog")
        ]
    if kind == "brave":
        return [
            ProviderRequest(
                "GET",
                base.url,
                base.headers,
                {
                    "q": query,
                    "count": "10",
                    "offset": str(page - 1),
                    "result_filter": "web",
                    "text_decorations": "false",
                    "summary": "false",
                    "search_lang": language,
                },
            )
        ]
    if page != 1:
        raise ValueError("Exa 검색은 첫 결과 묶음만 지원합니다")
    return [
        ProviderRequest(
            "POST",
            base.url,
            base.headers,
            body={
                "query": query,
                "type": "fast",
                "numResults": 10,
                "contents": {"text": {"maxCharacters": 1500}},
            },
        )
    ]


def parse_search_response(
    kind: str, payload: Any, *, fetched_at: datetime, secrets: tuple[str, ...] = ()
) -> list[SearchDocument]:
    if not isinstance(payload, dict):
        raise ValueError("검색 응답 형식을 확인할 수 없습니다")
    if kind.startswith("naver_"):
        rows = payload.get("items")
    elif kind == "brave":
        web = payload.get("web", {})
        rows = web.get("results", []) if isinstance(web, dict) else None
        if "web" not in payload and not isinstance(payload.get("query"), dict):
            rows = None
    else:
        rows = payload.get("results")
    if not isinstance(rows, list):
        raise ValueError("검색 결과 목록이 없습니다")
    results: list[SearchDocument] = []
    for row in rows[:10]:
        if not isinstance(row, dict):
            continue
        url = canonical_document_url(
            row.get("link") if kind.startswith("naver_") else row.get("url")
        )
        title = plain_excerpt(row.get("title"), 300)
        text = row.get("text") if kind == "exa" else row.get("description")
        excerpt = plain_excerpt(text)
        if (
            not url
            or not title
            or any(secret and secret in (url + title + excerpt) for secret in secrets)
        ):
            continue
        published = row.get("publishedDate") or row.get("postdate") or row.get("page_age")
        published = plain_excerpt(published, 60) or None
        # 제목·발췌에 명시된 종류만 구분한다. 맛/평점/긍부정은 추론하지 않는다.
        corpus = f"{title} {excerpt}".lower()
        category = "unknown"
        for label, terms in (
            ("service_review", ("배송 후기", "포장 후기", "매장 평가")),
            ("seller_note", ("판매자 테이스팅", "seller tasting", "판매자 노트")),
            ("customer_tasting", ("시음 후기", "음용 후기", "tasting review")),
            ("review", ("review", "리뷰", "평론")),
            ("info", ("제품 정보", "product information", "양조장", "distillery")),
        ):
            if any(term in corpus for term in terms):
                category = label
                break
        results.append(
            SearchDocument(
                id=hashlib.sha256(url.encode()).hexdigest()[:24],
                url=url,
                domain=urlsplit(url).hostname or "",
                title=title,
                excerpt=excerpt,
                published_at=published,
                fetched_at=fetched_at,
                evidence="provider_text" if kind == "exa" and excerpt else "search_excerpt",
                kind=category,
                discovered_by=[kind],
            )
        )
    return deduplicate_documents(results)


def deduplicate_documents(documents: list[SearchDocument]) -> list[SearchDocument]:
    merged: dict[str, SearchDocument] = {}
    for doc in documents:
        if doc.url not in merged:
            merged[doc.url] = doc
        else:
            prior = merged[doc.url]
            prior.discovered_by = sorted(set(prior.discovered_by + doc.discovered_by))
            if len(doc.excerpt) > len(prior.excerpt):
                prior.excerpt, prior.evidence = doc.excerpt, doc.evidence
    return list(merged.values())


async def search_provider(
    kind: str,
    credentials: dict[str, str],
    *,
    query: str,
    before_request: BeforeRequest,
    page: int = 1,
    language: str = "ko",
    transport: httpx.AsyncBaseTransport | None = None,
) -> SearchResult:
    requests = build_search_requests(kind, credentials, query=query, page=page, language=language)
    documents: list[SearchDocument] = []
    outcome = SourceOutcome.EMPTY
    count = 0
    try:
        host = httpx.URL(requests[0].url).host
        async with SafeHttpClient(
            [host],
            credential_host=host,
            credential_headers=requests[0].headers,
            before_request=before_request,
            transport=transport,
            limits=HttpLimits(deadline_seconds=18, max_retries=0, max_redirects=0),
        ) as client:
            for request in requests:
                count += 1
                response = await client.request(
                    request.method, request.url, params=request.params, json=request.body
                )
                if response.status_code != 200:
                    outcome = {
                        401: SourceOutcome.AUTHENTICATION_FAILED,
                        403: SourceOutcome.FORBIDDEN,
                        429: SourceOutcome.RATE_LIMITED,
                    }.get(response.status_code, SourceOutcome.NETWORK_ERROR)
                    break
                documents.extend(
                    parse_search_response(
                        kind,
                        response.json(),
                        fetched_at=datetime.now(UTC),
                        secrets=tuple(credentials.values()),
                    )
                )
            else:
                outcome = SourceOutcome.SUCCESS if documents else SourceOutcome.EMPTY
    except RequestBudgetExceeded:
        outcome = SourceOutcome.RATE_LIMITED
    except UnsafeRequest:
        outcome = SourceOutcome.POLICY_BLOCKED
    except httpx.HTTPError, TimeoutError:
        outcome = SourceOutcome.NETWORK_ERROR
    except ValueError, TypeError:
        outcome = SourceOutcome.PARSE_ERROR
    failed = outcome not in {SourceOutcome.SUCCESS, SourceOutcome.EMPTY}
    return SearchResult(
        outcome=SourceOutcome.PARTIAL if failed and documents else outcome,
        documents=deduplicate_documents(documents),
        requests=count,
        warning="일부 검색을 완료하지 못했습니다. 확인된 결과는 유지합니다." if failed else None,
    )
