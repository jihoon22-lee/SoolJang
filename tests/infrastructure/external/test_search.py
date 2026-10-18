"""검색 계약은 실제 요청 내용·부분 실패·출처 identity 보존으로 검증한다."""

import json
from datetime import UTC, datetime

import httpx
import pytest

from sooljang.domain.discovery import RequestBudgetExceeded, SourceOutcome
from sooljang.infrastructure.external.search import (
    build_search_requests,
    canonical_document_url,
    deduplicate_documents,
    parse_search_response,
    search_provider,
)

CREDENTIALS = {
    "api_key": "synthetic-search-key",
    "client_id": "synthetic-id",
    "client_secret": "synthetic-search-secret",
}


def test_search_keeps_origin_rank_query_language_and_normalizes_provider_dates() -> None:
    docs = parse_search_response(
        "naver_hub",
        {
            "items": [
                {
                    "title": "제품 정보",
                    "link": "https://example.org/product",
                    "postdate": "20261011",
                }
            ]
        },
        fetched_at=datetime(2026, 10, 11, tzinfo=UTC),
        query="확인한 한국어 질의",
        language="ko",
        page=2,
        channel="blog",
    )
    assert docs[0].published_at == "2026-10-11"
    assert docs[0].origins == [
        {
            "provider": "naver_hub",
            "channel": "blog",
            "rank": 11,
            "query": "확인한 한국어 질의",
            "language": "ko",
        }
    ]


def test_unknown_or_relative_publication_date_is_not_replaced_by_fetch_time() -> None:
    docs = parse_search_response(
        "brave",
        {
            "web": {
                "results": [
                    {"title": "글", "url": "https://example.org/a", "page_age": "2 days ago"}
                ]
            }
        },
        fetched_at=datetime(2026, 10, 11, tzinfo=UTC),
    )
    assert docs[0].published_at is None


def test_purpose_separates_retail_service_from_product_information() -> None:
    docs = parse_search_response(
        "exa",
        {
            "results": [
                {
                    "title": "배송 후기",
                    "url": "https://example.org/delivery",
                    "text": "제품 정보와 배송 후기",
                },
                {"title": "판매 가격과 구매 안내", "url": "https://example.org/shop"},
                {"title": "제조사 제품 정보", "url": "https://example.org/info"},
            ]
        },
        fetched_at=datetime(2026, 10, 11, tzinfo=UTC),
    )
    assert [doc.kind for doc in docs] == ["service_review", "offer", "info"]


@pytest.mark.parametrize("kind", ["naver_hub", "naver_legacy", "brave", "exa"])
async def test_search_requests_have_bounded_non_generative_contract(kind: str) -> None:
    calls = []
    reservations = []

    async def reserve(request: httpx.Request) -> None:
        reservations.append(request.url.host)

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        row = {
            "title": "가상 술 12년 46% 시음 후기",
            "url": "https://review.example.org/drink?sku=700&vintage=2020",
            "link": "https://review.example.org/drink?sku=700&vintage=2020",
            "text": "직접 시음한 기록",
            "description": "직접 시음한 기록",
        }
        return httpx.Response(
            200, json={"items": [row], "results": [row], "web": {"results": [row]}}
        )

    result = await search_provider(
        kind,
        CREDENTIALS,
        query="가상 술 12년",
        before_request=reserve,
        transport=httpx.MockTransport(respond),
    )
    assert result.outcome == SourceOutcome.SUCCESS
    assert len(calls) == len(reservations) == (2 if kind.startswith("naver_") else 1)
    assert len(result.documents) == 1
    assert result.documents[0].evidence == ("provider_text" if kind == "exa" else "search_excerpt")
    assert result.documents[0].kind == "customer_tasting"
    assert result.documents[0].rating is None
    for request in calls:
        assert not any(
            path in request.url.path.lower()
            for path in ("answer", "summary", "chat", "completions", "research")
        )
        if kind == "exa":
            assert json.loads(request.content) == {
                "query": "가상 술 12년",
                "type": "fast",
                "numResults": 10,
                "contents": {"text": {"maxCharacters": 1500}},
            }
        else:
            assert not request.content
        assert "synthetic-search" not in str(request.url)
    assert "synthetic-search" not in repr(result)


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://127.0.0.1/a",
        "http://localhost/a",
        "https://user:pass@example.org",
        "https://example.org?api_key=secret",
        "https://example.org?access_token=secret",
        "https://example.org:8443/a",
        None,
    ],
)
def test_unsafe_or_secret_document_links_are_discarded(url: str | None) -> None:
    assert canonical_document_url(url) is None


def test_dedup_keeps_edition_sku_and_multiple_discovery_provenance() -> None:
    now = datetime.now(UTC)
    first = parse_search_response(
        "exa",
        {
            "results": [
                {
                    "title": "Wine",
                    "url": "https://example.org/a?sku=700&vintage=2020&utm_source=exa#variant",
                }
            ]
        },
        fetched_at=now,
    )
    second = parse_search_response(
        "brave",
        {
            "web": {
                "results": [
                    {
                        "title": "Wine",
                        "url": "https://example.org/a?sku=700&vintage=2020&gclid=1#variant",
                        "description": "긴 설명",
                    },
                    {"title": "Wine", "url": "https://example.org/a?sku=700&vintage=2021#variant"},
                ]
            }
        },
        fetched_at=now,
    )
    docs = deduplicate_documents(first + second)
    assert len(docs) == 2
    assert docs[0].discovered_by == ["brave", "exa"]
    assert docs[0].excerpt == "긴 설명"
    assert docs[0].url.endswith("vintage=2020#variant")


@pytest.mark.parametrize("status", [401, 403, 429, 500])
async def test_partial_naver_failure_preserves_first_vertical_without_retry(status: int) -> None:
    calls = []

    async def reserve(_request: httpx.Request) -> None:
        pass

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 2:
            return httpx.Response(status, text="secret-error-must-not-return")
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "title": "술 정보",
                        "link": "https://example.org/a",
                        "description": "확인된 발췌",
                    }
                ]
            },
        )

    result = await search_provider(
        "naver_legacy",
        CREDENTIALS,
        query="술",
        before_request=reserve,
        transport=httpx.MockTransport(respond),
    )
    assert result.outcome == SourceOutcome.PARTIAL and len(result.documents) == 1
    assert len(calls) == 2
    assert "secret-error" not in repr(result)


async def test_budget_stops_before_send_and_zero_result_is_not_failure() -> None:
    calls = []

    async def exhausted(_request: httpx.Request) -> None:
        raise RequestBudgetExceeded("limit")

    result = await search_provider(
        "exa",
        CREDENTIALS,
        query="술",
        before_request=exhausted,
        transport=httpx.MockTransport(lambda r: (calls.append(r), httpx.Response(200))[1]),
    )
    assert result.outcome == SourceOutcome.RATE_LIMITED and calls == []

    async def reserve(_request: httpx.Request) -> None:
        pass

    result = await search_provider(
        "exa",
        CREDENTIALS,
        query="술",
        before_request=reserve,
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"results": []})),
    )
    assert result.outcome == SourceOutcome.EMPTY


def test_external_html_and_credential_reflection_are_not_rendered() -> None:
    docs = parse_search_response(
        "exa",
        {
            "results": [
                {
                    "title": "<b>안전 제목</b>",
                    "url": "https://example.org/a",
                    "text": "<script>alert(1)</script>설명<img src=x onerror=alert(1)>",
                },
                {"title": "synthetic-search-key", "url": "https://example.org/b"},
            ]
        },
        fetched_at=datetime.now(UTC),
        secrets=("synthetic-search-key",),
    )
    assert len(docs) == 1 and docs[0].title == "안전 제목" and docs[0].excerpt == "설명"


@pytest.mark.parametrize(
    "kind,page,query",
    [("openai_ocr", 1, "술"), ("exa", 2, "술"), ("brave", 4, "술"), ("exa", 1, " ")],
)
def test_invalid_contract_has_no_request(kind: str, page: int, query: str) -> None:
    with pytest.raises(ValueError):
        build_search_requests(kind, CREDENTIALS, query=query, page=page)


async def test_cancelled_request_has_no_send_or_reservation_and_guard_does_not_leak() -> None:
    import asyncio

    from sooljang.infrastructure.external.request_guard import outbound_guard

    calls: list[str] = []
    reservations: list[str] = []

    async def cancelled(_request: httpx.Request) -> None:
        raise asyncio.CancelledError

    async def reserve(_request: httpx.Request) -> None:
        reservations.append("reserved")

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        return httpx.Response(200, json={"results": []})

    with outbound_guard(cancelled), pytest.raises(asyncio.CancelledError):
        await search_provider(
            "exa",
            CREDENTIALS,
            query="술",
            before_request=reserve,
            transport=httpx.MockTransport(respond),
        )
    assert calls == reservations == []
    result = await search_provider(
        "exa",
        CREDENTIALS,
        query="술",
        before_request=reserve,
        transport=httpx.MockTransport(respond),
    )
    assert result.outcome == SourceOutcome.EMPTY
    assert len(calls) == len(reservations) == 1


@pytest.mark.parametrize("encoded_prefix", ["%73", "%2573", "%252573"])
def test_percent_encoded_credential_reflection_is_discarded(encoded_prefix: str) -> None:
    secret = "synthetic-exa-secret-123456"  # scan-secrets-allow: synthetic reflection fixture
    documents = parse_search_response(
        "exa",
        {
            "results": [
                {
                    "title": "합성 몰트",
                    "url": "https://example.com/" + encoded_prefix + secret[1:],
                    "text": "합성 발췌",
                }
            ]
        },
        fetched_at=datetime.now(UTC),
        secrets=(secret,),
    )
    assert documents == []


def test_duplicate_merge_keeps_rich_text_and_purpose_independent_of_response_order() -> None:
    from dataclasses import replace
    from itertools import permutations

    base = parse_search_response(
        "exa",
        {
            "results": [
                {"url": "https://example.org/shared", "title": "제품 정보", "text": "상세 설명"}
            ]
        },
        fetched_at=datetime(2026, 10, 11, tzinfo=UTC),
    )[0]
    variants = [
        replace(base, title="충실한 설명", excerpt="내용" * 50, kind="unknown"),
        replace(base, title="판매자 테이스팅", excerpt="판매자", kind="seller_note"),
        replace(base, title="리뷰", excerpt="설명", kind="review", published_at="2026-10-01"),
    ]
    results = [deduplicate_documents(list(order)) for order in permutations(variants)]
    assert all(result == results[0] for result in results)
    assert results[0][0].excerpt == "내용" * 50
    assert results[0][0].kind == "seller_note"
    assert results[0][0].published_at == "2026-10-01"


def test_publication_date_beyond_utc_range_is_unknown_instead_of_raising() -> None:
    from sooljang.infrastructure.external.search import normalized_publication_date

    assert normalized_publication_date("9999-12-31T23:59:59-14:00") is None
    assert normalized_publication_date("2026-10-01T09:00:00+09:00") == "2026-10-01T00:00:00+00:00"
