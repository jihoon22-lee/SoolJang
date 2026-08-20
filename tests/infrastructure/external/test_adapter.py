"""`adapter` 전략(§7.2) 실행 테스트. 실제 네트워크를 타지 않는다 — `httpx.MockTransport`.

셀렉터가 깨지거나 robots.txt 가 막는 경우 예외 대신 `degraded=True` 부분 결과를 반환하는
계약(§7.2)을 각 실패 유형별로 확인한다.
"""

import json
from typing import Any

import httpx
import pytest

from sooljang.infrastructure.external.adapter import (
    AUTO_ACCEPT,
    MAX_CANDIDATES,
    MIN_CANDIDATE,
    PinnedMatch,
    fetch_snapshot,
    reset_robots_cache,
)
from sooljang.infrastructure.external.matching import ProductIdentity

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
            "price_krw": {
                "selector": ".price",
                "attr": "text",
                "transform": ["strip_currency", "to_number"],
            },
            "rating": {"selector": ".rating", "attr": "text", "transform": ["to_number"]},
            "rating_scale": {"const": 5},
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
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields == {"price_krw": 35000, "rating": 4.5, "rating_scale": 5.0}
    assert result.degraded is False
    assert result.warning is None


async def test_셀렉터가_깨지면_부분_결과와_degraded를_반환한다() -> None:
    transport = _transport(
        {"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_NO_RATING)}
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields["price_krw"] == 35000
    assert result.fields["rating"] is None
    assert result.degraded is True
    assert result.warning is not None
    assert "rating" in result.warning


async def test_검색_결과가_없으면_후보_없음으로_처리한다() -> None:
    transport = _transport({"/search": (200, "<div>결과 없음</div>")})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
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
        identity=ProductIdentity(name="완전히 다른 제품명"),
        transport=transport,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "비슷한" in result.warning


async def test_증류소_이름이_다르면_접두사만_같아도_후보로_보지_않는다() -> None:
    # "글렌고인" 을 검색했는데 "글렌리벳" 만 있다 — 둘 다 "글렌…" 으로 시작해 전체 문자열
    # 유사도(0.53)는 옛 임계값(0.4)을 넘었다. 실측(데일리샷)에서 실제로 겪은 오탐이다.
    # Task 34 PR2 의 토큰 집합 점수는 이 조합을 0.2 로 떨어뜨려, 접두사 게이트라는
    # 임시방편 없이도 걸러낸다.
    search_page = """
    <div class="product-card">
      <span class="title">글렌리벳 12년</span>
      <a href="/product/1">보기</a>
    </div>
    """
    transport = _transport({"/search": (200, search_page)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌고인 12년"),
        transport=transport,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "충분히 비슷한 후보가 없습니다" in result.warning


async def test_robots_txt가_검색_페이지를_막으면_조회하지_않는다() -> None:
    transport = _transport(
        {
            "/robots.txt": (200, "User-agent: *\nDisallow: /search"),
            "/search": (200, _SEARCH_PAGE),
            "/product/1": (200, _DETAIL_PAGE_FULL),
        }
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
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
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "robots.txt" in result.warning


async def test_검색_페이지_조회_실패시_degraded를_반환한다() -> None:
    transport = _transport({"/search": (500, "internal error")})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "검색 페이지" in result.warning


async def test_상세_페이지_조회_실패시_출처_URL은_남기고_degraded를_반환한다() -> None:
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (500, "internal error")})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields == {}
    assert result.degraded is True
    assert result.warning is not None
    assert "상세 페이지" in result.warning


async def test_search_설정이_없으면_바로_degraded를_반환한다() -> None:
    result = await fetch_snapshot(
        {"detail": {"fields": {}}},
        base_url="https://example.com",
        identity=ProductIdentity(name="아무거나"),
        transport=None,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None


async def test_성공하면_ok가_True다() -> None:
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.ok is True


async def test_상세_페이지_조회_실패시_ok는_False다() -> None:
    # source_url 은 채워지지만(어느 URL 을 시도했는지 남긴다) 실패는 실패다 — 호출자가
    # 이 결과를 성공처럼 캐시하지 않도록 `ok` 로 구분한다.
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (500, "internal error")})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.ok is False


async def test_search가_dict가_아니면_예외_대신_degraded를_반환한다() -> None:
    result = await fetch_snapshot(
        {"search": "이건 문자열입니다"},
        base_url="https://example.com",
        identity=ProductIdentity(name="아무거나"),
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
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕"),
        transport=None,
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
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
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
                "price_krw": {"selector": ".price", "attr": "text", "transform": ["nonexistent"]},
            }
        },
    }
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields["price_krw"] is None
    assert result.fields["rating"] == 4.5
    assert result.degraded is True


async def test_필드_스펙이_dict가_아니면_그_필드만_건너뛴다() -> None:
    spec = {
        **ADAPTER_SPEC,
        "detail": {"fields": {**ADAPTER_SPEC["detail"]["fields"], "price_krw": "그냥 문자열"}},
    }
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.fields["price_krw"] is None
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
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
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
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
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
            "price_krw": {"path": "price"},
            "rating": {"path": "review_rate"},
            "rating_scale": {"const": 5},
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
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url == "https://example.com/item/1"
    assert result.fields == {"price_krw": 35000, "rating": 4.5, "rating_scale": 5.0}
    assert result.degraded is False
    assert result.warning is None
    assert result.ok is True


async def test_JSON_결과_필드가_없으면_degraded와_경고를_반환한다() -> None:
    body = json.dumps({"results": [{"id": 1, "name": "글렌피딕 12년", "price": 35000}]})
    transport = _transport({"/api/search": (200, body)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.fields["price_krw"] == 35000
    assert result.fields["rating"] is None
    assert result.degraded is True
    assert result.warning is not None
    assert "rating" in result.warning


async def test_JSON_모드에서_검색_응답이_올바른_JSON이_아니면_degraded를_반환한다() -> None:
    transport = _transport({"/api/search": (200, "이건 JSON이 아닙니다")})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕"),
        transport=transport,
    )

    assert result.source_url is None
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None


async def test_JSON_모드에서_item_경로가_리스트가_아니면_후보_없음으로_처리한다() -> None:
    body = json.dumps({"results": {"not": "a list"}})
    transport = _transport({"/api/search": (200, body)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕"),
        transport=transport,
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
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
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
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None
    assert "후보" in result.warning


# --- 후보 노출과 매칭 고정(Task 34 PR1) ---------------------------------------
#: 이름이 서로 다른 상품 셋. 질의를 바꿔 가며 자동 채택·확인 필요·후보 없음 구간을 만든다.
_MULTI_SEARCH_PAGE = """
<div class="product-card">
  <span class="title">글렌피딕 12년</span>
  <a href="/product/1">보기</a>
</div>
<div class="product-card">
  <span class="title">글렌피딕 15년 솔레라</span>
  <a href="/product/2">보기</a>
</div>
<div class="product-card">
  <span class="title">글렌피딕 18년 스몰배치</span>
  <a href="/product/3">보기</a>
</div>
"""


async def test_자동_채택_구간이면_확인이_필요없고_후보도_함께_온다() -> None:
    transport = _transport(
        {"/search": (200, _MULTI_SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)}
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    assert result.matched_name == "글렌피딕 12년"
    assert result.match_score is not None and result.match_score >= AUTO_ACCEPT
    assert result.needs_confirmation is False
    # 자동 채택이어도 후보는 준다 — 사용자가 다른 것을 고를 수 있어야 한다.
    assert [candidate.name for candidate in result.candidates][0] == "글렌피딕 12년"
    assert len(result.candidates) == 3


async def test_확인_필요_구간이면_값은_주되_needs_confirmation을_세운다() -> None:
    transport = _transport(
        {"/search": (200, _MULTI_SEARCH_PAGE), "/product/2": (200, _DETAIL_PAGE_FULL)}
    )

    # PR2 의 토큰 점수에서는 "글렌피딕 솔레라" 가 "글렌피딕 15년 솔레라" 와 토큰이 완전히
    # 같아져(연식은 속성으로 빠진다) 1.0 이 된다 — 자동 채택 구간이라 이 테스트의 의도를
    # 벗어난다. 한쪽에만 있는 토큰을 하나 더해 0.729 로 확인 필요 구간에 들어가게 한다.
    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 솔레라 리저브"),
        transport=transport,
    )

    assert result.fields["price_krw"] == 35000
    assert result.matched_name == "글렌피딕 15년 솔레라"
    assert MIN_CANDIDATE <= (result.match_score or 0) < AUTO_ACCEPT
    assert result.needs_confirmation is True


async def test_점수가_낮으면_값_없이_후보만_돌려준다() -> None:
    transport = _transport({"/search": (200, _MULTI_SEARCH_PAGE)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌드로낙 21년"),
        transport=transport,
    )

    assert result.fields == {}
    assert result.ok is False
    assert result.degraded is True
    # 사용자가 직접 고를 수 있도록 후보는 남긴다.
    assert len(result.candidates) == 3


async def test_후보는_점수_내림차순이고_최대_다섯개다() -> None:
    many = "".join(
        f'<div class="product-card"><span class="title">글렌피딕 {n}년</span>'
        f'<a href="/product/{n}">보기</a></div>'
        for n in range(1, 9)
    )
    transport = _transport({"/search": (200, many), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 1년"),
        transport=transport,
    )

    scores = [candidate.score for candidate in result.candidates]
    assert len(result.candidates) == MAX_CANDIDATES
    assert scores == sorted(scores, reverse=True)


async def test_고정되어_있으면_검색을_아예_건너뛴다() -> None:
    # 검색 경로를 등록하지 않는다 — 검색을 시도하면 KeyError 로 실패해, 정말로
    # 건너뛰었는지가 테스트로 강제된다.
    transport = _transport({"/product/2": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="아무 이름이나"),
        transport=transport,
        pinned=PinnedMatch(external_url="https://example.com/product/2", external_key=None),
    )

    assert result.source_url == "https://example.com/product/2"
    assert result.fields["price_krw"] == 35000
    assert result.pinned is True
    assert result.needs_confirmation is False


async def test_고정된_URL_이_다른_호스트면_조회하지_않는다() -> None:
    transport = _transport({"/product/2": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
        pinned=PinnedMatch(external_url="https://evil.example.net/product/2", external_key=None),
    )

    assert result.source_url is None
    assert result.degraded is True
    assert result.warning is not None and "밖" in result.warning


async def test_result_fields_모드는_고정돼도_검색하되_키로_고른다() -> None:
    # 질의는 1번 상품과 훨씬 비슷하지만, 고정된 키가 2번이므로 2번이 선택돼야 한다.
    transport = _transport({"/api/search": (200, _JSON_SEARCH_BODY)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
        pinned=PinnedMatch(external_url="https://example.com/item/2", external_key="2"),
    )

    assert result.source_url == "https://example.com/item/2"
    assert result.fields["price_krw"] == 45000
    assert result.pinned is True


async def test_고정된_상품이_검색결과에서_사라지면_유사도로_폴백하지_않는다() -> None:
    transport = _transport({"/api/search": (200, _JSON_SEARCH_BODY)})

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
        pinned=PinnedMatch(external_url="https://example.com/item/99", external_key="99"),
    )

    assert result.fields == {}
    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None and "고정된 상품" in result.warning
    # 재고정할 수 있도록 후보는 함께 준다.
    assert len(result.candidates) == 2


# --- 질의 확장(Task 34 PR2) ----------------------------------------------------
async def test_첫_질의가_자동_채택이면_두번째_질의를_보내지_않는다() -> None:
    """질의 하나가 HTTP 요청 1회라 소스의 rate limit 을 그만큼 소비한다 — 조기 종료가 기본."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        if request.url.path == "/search":
            calls.append(request.url.params.get("q", ""))
            return httpx.Response(200, text=_SEARCH_PAGE)
        return httpx.Response(200, text=_DETAIL_PAGE_FULL)

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년", name_en="Glenfiddich 12"),
        transport=httpx.MockTransport(handler),
    )

    assert result.needs_confirmation is False
    assert len(calls) == 1


async def test_첫_질의가_실패하면_영문명으로_다시_시도한다() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        if request.url.path == "/search":
            query = request.url.params.get("q", "")
            calls.append(query)
            # 국내 몰에 영문명으로만 올라온 상품을 흉내 낸다.
            if "Glenfiddich" not in query:
                return httpx.Response(200, text="<div>결과 없음</div>")
            return httpx.Response(
                200,
                text=(
                    '<div class="product-card">'
                    '<span class="title">Glenfiddich 12</span>'
                    '<a href="/product/1">보기</a>'
                    "</div>"
                ),
            )
        return httpx.Response(200, text=_DETAIL_PAGE_FULL)

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년", name_en="Glenfiddich 12"),
        transport=httpx.MockTransport(handler),
    )

    assert result.source_url == "https://example.com/product/1"
    assert result.fields["price_krw"] == 35000
    assert len(calls) == 2


async def test_고정된_소스는_질의를_확장하지_않는다() -> None:
    """고정돼 있으면 어차피 그 상품만 찾으면 되므로 요청을 늘릴 이유가 없다."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        calls.append(request.url.path)
        return httpx.Response(200, text=_DETAIL_PAGE_FULL)

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        identity=ProductIdentity(name="없는 이름", name_en="Nonexistent"),
        transport=httpx.MockTransport(handler),
        pinned=PinnedMatch(external_url="https://example.com/product/1", external_key=None),
    )

    assert result.pinned is True
    assert calls == ["/product/1"]


# --- 표준 필드와 extra 폴백(Task 34 PR3) --------------------------------------
async def test_표준_키가_아닌_필드는_extra로_보존된다() -> None:
    """데일리샷처럼 한글 키를 쓰는 기존 소스가 이 PR 로 깨지면 안 된다.

    비교 표에 안 잡힐 뿐 값은 그대로 남아야 한다.
    """
    spec: dict[str, Any] = {
        **ADAPTER_SPEC,
        "detail": {
            "fields": {
                "price_krw": {"selector": ".price", "attr": "text"},
                "가격": {"selector": ".price", "attr": "text"},
                "평점": {"selector": ".rating", "attr": "text"},
            }
        },
    }
    transport = _transport({"/search": (200, _SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)})

    result = await fetch_snapshot(
        spec,
        base_url="https://example.com",
        identity=ProductIdentity(name="글렌피딕 12년"),
        transport=transport,
    )

    # 표준 키는 타입까지 맞춰 정규화된다("35,000원" → 35000).
    assert result.fields == {"price_krw": 35000}
    # 나머지는 원문 그대로 보존된다.
    assert result.extra == {"가격": "35,000원", "평점": "4.5"}
