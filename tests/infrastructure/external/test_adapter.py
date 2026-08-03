"""`adapter` 전략(§7.2) 실행 테스트. 실제 네트워크를 타지 않는다 — `httpx.MockTransport`.

셀렉터가 깨지거나 robots.txt 가 막는 경우 예외 대신 `degraded=True` 부분 결과를 반환하는
계약(§7.2)을 각 실패 유형별로 확인한다.
"""

import httpx
import pytest

from sooljang.infrastructure.external.adapter import fetch_snapshot, reset_robots_cache

#: 도메인별 robots.txt 캐시가 테스트 간에 새지 않게 한다 — 여러 테스트가 같은
#: `https://example.com` 도메인에 서로 다른 robots.txt 를 흉내 낸다.
pytestmark = pytest.mark.usefixtures("_reset_robots_cache")


@pytest.fixture
def _reset_robots_cache() -> None:
    reset_robots_cache()


ADAPTER_SPEC = {
    "search": {
        "url_template": "https://example.com/search?q={query}",
        "item": ".product-card",
        "fields": {
            "name": {"selector": ".title", "attr": "text"},
            "url": {"selector": "a", "attr": "href", "absolute": True},
        },
    },
    "detail": {
        "fields": {
            "price": {
                "selector": ".price",
                "attr": "text",
                "transform": ["strip_currency", "to_number"],
            },
            "rating": {"selector": ".rating", "attr": "text", "transform": ["to_number"]},
            "scale": {"const": 5},
        }
    },
}

_ROBOTS_ALLOW_ALL = "User-agent: *\nAllow: /"

_SEARCH_PAGE = """
<div class="product-card">
  <span class="title">글렌피딕 12년</span>
  <a href="/product/1">보기</a>
</div>
"""

_DETAIL_PAGE_FULL = """
<div class="price">35,000원</div>
<div class="rating">4.5</div>
"""

_DETAIL_PAGE_NO_RATING = """
<div class="price">35,000원</div>
"""


def _transport(pages: dict[str, tuple[int, str]]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            status, body = pages.get("/robots.txt", (200, _ROBOTS_ALLOW_ALL))
            return httpx.Response(status, text=body)
        status, body = pages[request.url.path]
        return httpx.Response(status, text=body)

    return httpx.MockTransport(handler)


async def test_검색과_상세를_통해_필드를_뽑는다() -> None:
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields == {"price": 35000.0, "rating": 4.5, "scale": 5}
    assert result.degraded is False
    assert result.warning is None


async def test_셀렉터가_깨지면_부분_결과와_degraded를_반환한다() -> None:
    transport = _transport(
        {"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_NO_RATING)}
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields["price"] == 35000.0
    assert result.fields["rating"] is None
    assert result.degraded is True
    assert result.warning is not None
    assert "rating" in result.warning


async def test_검색_결과가_없으면_후보_없음으로_처리한다() -> None:
    transport = _transport({"/search": (200, "<div>결과 없음</div>")})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "후보" in result.warning


async def test_이름이_너무_다르면_후보로_보지_않는다() -> None:
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        query="완전히 다른 제품명",
        transport=transport,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "비슷한" in result.warning


async def test_robots_txt가_검색_페이지를_막으면_조회하지_않는다() -> None:
    transport = _transport(
        {
            "/robots.txt": (200, "User-agent: *\nDisallow: /search"),
            "/search": (200, _SEARCH_PAGE),
            "/product/1": (200, _DETAIL_PAGE_FULL),
        }
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "robots.txt" in result.warning


async def test_robots_txt가_상세_페이지만_막으면_상세를_조회하지_않는다() -> None:
    transport = _transport(
        {
            "/robots.txt": (200, "User-agent: *\nAllow: /search\nDisallow: /product/"),
            "/search": (200, _SEARCH_PAGE),
            "/product/1": (200, _DETAIL_PAGE_FULL),
        }
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "robots.txt" in result.warning


async def test_검색_페이지_조회_실패시_degraded를_반환한다() -> None:
    transport = _transport({"/search": (500, "internal error")})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "검색 페이지" in result.warning


async def test_상세_페이지_조회_실패시_출처_URL은_남기고_degraded를_반환한다() -> None:
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (500, "internal error")})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields == {}
    assert result.degraded is True
    assert result.warning is not None
    assert "상세 페이지" in result.warning


async def test_search_설정이_없으면_바로_degraded를_반환한다() -> None:
    result = await fetch_snapshot(
        {"detail": {"fields": {}}}, base_url="https://example.com", query="아무거나", transport=None
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
