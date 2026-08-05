"""`adapter` 전략(§7.2) 실행 테스트. 실제 네트워크를 타지 않는다 — `httpx.MockTransport`.

셀렉터가 깨지거나 robots.txt 가 막는 경우 예외 대신 `degraded=True` 부분 결과를 반환하는
계약(§7.2)을 각 실패 유형별로 확인한다.
"""

import json
from typing import Any

import httpx
import pytest

from sooljang.infrastructure.external.adapter import fetch_snapshot, reset_robots_cache

#: 도메인별 robots.txt 캐시가 테스트 간에 새지 않게 한다 — 여러 테스트가 같은
#: `https://example.com` 도메인에 서로 다른 robots.txt 를 흉내 낸다.
pytestmark = pytest.mark.usefixtures("_reset_robots_cache")


@pytest.fixture
def _reset_robots_cache() -> None:
    reset_robots_cache()


#: 여러 테스트가 이 스펙 일부를 스프레드(`**ADAPTER_SPEC["detail"]["fields"]`)로 변형해
#: 재사용한다. 명시적으로 `dict[str, Any]` 로 두지 않으면 리터럴에서 추론된 좁은 유니온
#: 타입 때문에 타입 체커가 그 스프레드를 매핑이 아니라고 오판한다.
ADAPTER_SPEC: dict[str, Any] = {
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


async def test_증류소_이름이_다르면_접두사만_같아도_후보로_보지_않는다() -> None:
    # "글렌고인" 을 검색했는데 "글렌리벳" 만 있다 — 둘 다 "글렌…" 으로 시작해 전체 문자열
    # 유사도(0.53)는 기존 임계값(0.4)을 넘지만, 실제로는 다른 증류소다. 실측(데일리샷)에서
    # 실제로 겪은 오탐이다 — 접두사 게이트가 이런 "다른 술인데 앞부분만 같은" 후보를
    # 걸러야 한다.
    search_page = """
    <div class="product-card">
      <span class="title">글렌리벳 12년</span>
      <a href="/product/1">보기</a>
    </div>
    """
    transport = _transport({"/search": (200, search_page)})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌고인 12년", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "앞부분" in result.warning


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


async def test_성공하면_ok가_True다() -> None:
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.ok is True


async def test_상세_페이지_조회_실패시_ok는_False다() -> None:
    # source_url 은 채워지지만(어느 URL 을 시도했는지 남긴다) 실패는 실패다 — 호출자가
    # 이 결과를 성공처럼 캐시하지 않도록 `ok` 로 구분한다.
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (500, "internal error")})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.ok is False


async def test_search가_dict가_아니면_예외_대신_degraded를_반환한다() -> None:
    result = await fetch_snapshot(
        {"search": "이건 문자열입니다"},
        base_url="https://example.com",
        query="아무거나",
        transport=None,
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True


async def test_url_template에_알_수_없는_치환자가_있으면_예외_대신_degraded를_반환한다() -> None:
    spec = {
        **ADAPTER_SPEC,
        "search": {**ADAPTER_SPEC["search"], "url_template": "https://example.com/search?q={oops}"},
    }

    result = await fetch_snapshot(
        spec, base_url="https://example.com", query="글렌피딕", transport=None
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None
    assert "url_template" in result.warning


async def test_검색_아이템_셀렉터가_문법_오류여도_예외_대신_degraded를_반환한다() -> None:
    spec = {
        **ADAPTER_SPEC,
        "search": {**ADAPTER_SPEC["search"], "item": ":::not-a-real-selector:::"},
    }
    transport = _transport({"/search": (200, _SEARCH_PAGE)})

    result = await fetch_snapshot(
        spec, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None


async def test_알_수_없는_transform은_해당_필드만_건너뛴다() -> None:
    spec = {
        **ADAPTER_SPEC,
        "detail": {
            "fields": {
                **ADAPTER_SPEC["detail"]["fields"],
                "price": {"selector": ".price", "attr": "text", "transform": ["nonexistent"]},
            }
        },
    }
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        spec, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields["price"] is None
    assert result.fields["rating"] == 4.5
    assert result.degraded is True


async def test_필드_스펙이_dict가_아니면_그_필드만_건너뛴다() -> None:
    spec = {
        **ADAPTER_SPEC,
        "detail": {"fields": {**ADAPTER_SPEC["detail"]["fields"], "price": "그냥 문자열"}},
    }
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        spec, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.fields["price"] is None
    assert result.degraded is True


async def test_검색_결과_링크가_다른_호스트면_상세를_조회하지_않는다() -> None:
    search_page_off_host = """
    <div class="product-card">
      <span class="title">글렌피딕 12년</span>
      <a href="https://evil.example/steal">보기</a>
    </div>
    """
    transport = _transport({"/search": (200, search_page_off_host)})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None
    assert "밖" in result.warning


async def test_상세_페이지가_다른_호스트로_리다이렉트되면_거부한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "example.com":
            if request.url.path == "/robots.txt":
                return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
            if request.url.path == "/search":
                return httpx.Response(200, text=_SEARCH_PAGE)
            if request.url.path == "/product/1":
                return httpx.Response(302, headers={"location": "https://evil.example/stolen"})
        if request.url.host == "evil.example":
            return httpx.Response(200, text=_DETAIL_PAGE_FULL)
        raise AssertionError(f"예상하지 못한 요청: {request.url}")

    transport = httpx.MockTransport(handler)

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None
    assert "리다이렉트" in result.warning


# --- JSON 모드(Task 24 후속) --------------------------------------------------
#: 최근 국내 쇼핑몰이 흔히 그렇듯(데일리샷에서 실제로 겪음), 검색 결과 페이지의 HTML 은
#: 비어 있고 대신 별도 JSON API 가 상품 정보를 전부 들고 있는 사이트를 흉내 낸다. 검색
#: 응답 자체에 가격·평점이 이미 있어 상세 페이지를 또 조회하지 않는다(`result_fields`).

JSON_ADAPTER_SPEC: dict[str, Any] = {
    "format": "json",
    "search": {
        "url_template": "https://example.com/api/search?q={query}",
        "item": "results",
        "fields": {
            "name": {"path": "name"},
            "url": {"url_template": "https://example.com/item/{id}"},
        },
        "result_fields": {
            "price": {"path": "price"},
            "rating": {"path": "review_rate"},
            "scale": {"const": 5},
        },
    },
}

_JSON_SEARCH_BODY = json.dumps(
    {
        "results": [
            {"id": 1, "name": "글렌피딕 12년", "price": 35000, "review_rate": 4.5},
            {"id": 2, "name": "발베니 12년", "price": 45000, "review_rate": 4.2},
        ]
    }
)


async def test_JSON_모드에서_검색_결과로_바로_필드를_뽑는다() -> None:
    # 상세 페이지 경로를 transport 에 등록하지 않는다 — 상세를 또 조회하려 들면
    # KeyError 로 테스트가 실패해 "정말 검색 응답만으로 끝냈는지" 를 함께 확인한다.
    transport = _transport({"/api/search": (200, _JSON_SEARCH_BODY)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        query="글렌피딕 12년",
        transport=transport,
    )

    assert result.source_url == "https://example.com/item/1"
    assert result.fields == {"price": 35000, "rating": 4.5, "scale": 5}
    assert result.degraded is False
    assert result.warning is None
    assert result.ok is True


async def test_JSON_결과_필드가_없으면_degraded와_경고를_반환한다() -> None:
    body = json.dumps({"results": [{"id": 1, "name": "글렌피딕 12년", "price": 35000}]})
    transport = _transport({"/api/search": (200, body)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        query="글렌피딕 12년",
        transport=transport,
    )

    assert result.fields["price"] == 35000
    assert result.fields["rating"] is None
    assert result.degraded is True
    assert result.warning is not None
    assert "rating" in result.warning


async def test_JSON_모드에서_검색_응답이_올바른_JSON이_아니면_degraded를_반환한다() -> None:
    transport = _transport({"/api/search": (200, "이건 JSON이 아닙니다")})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕", transport=transport
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None


async def test_JSON_모드에서_item_경로가_리스트가_아니면_후보_없음으로_처리한다() -> None:
    body = json.dumps({"results": {"not": "a list"}})
    transport = _transport({"/api/search": (200, body)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "후보" in result.warning


async def test_JSON_모드에서도_링크가_다른_호스트면_거부한다() -> None:
    spec = {
        **JSON_ADAPTER_SPEC,
        "search": {
            **JSON_ADAPTER_SPEC["search"],
            "fields": {
                "name": {"path": "name"},
                "url": {"url_template": "https://evil.example/item/{id}"},
            },
        },
    }
    transport = _transport({"/api/search": (200, _JSON_SEARCH_BODY)})

    result = await fetch_snapshot(
        spec, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None
    assert "밖" in result.warning


async def test_JSON_url_template에_없는_필드를_참조하면_그_후보만_건너뛴다() -> None:
    spec = {
        **JSON_ADAPTER_SPEC,
        "search": {
            **JSON_ADAPTER_SPEC["search"],
            "fields": {
                "name": {"path": "name"},
                "url": {"url_template": "https://example.com/item/{missing_field}"},
            },
        },
    }
    transport = _transport({"/api/search": (200, _JSON_SEARCH_BODY)})

    result = await fetch_snapshot(
        spec, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "후보" in result.warning
