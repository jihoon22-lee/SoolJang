"""`adapter` 전략(§7.2) 실행 테스트. 실제 네트워크를 타지 않는다 — `httpx.MockTransport`.

셀렉터가 깨지거나 robots.txt 가 막는 경우 예외 대신 `degraded=True` 부분 결과를 반환하는
계약(§7.2)을 각 실패 유형별로 확인한다.

`# --- 신뢰 구간과 매칭 고정 ---` 이하는 Task 34 PR1(§7.4) — 자동 채택/확인 필요/후보 없음
3분할과 `PinnedMatch` 로 검색을 건너뛰거나 URL 일치로 고르는 경로를 확인한다.
"""

import json
from typing import Any

import httpx
import pytest

from sooljang.infrastructure.external.adapter import (
    PinnedMatch,
    fetch_snapshot,
    reset_robots_cache,
)

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


# --- 신뢰 구간과 매칭 고정(Task 34 PR1, §7.4) --------------------------------
#: 후보가 여러 개인 검색 결과. 각 항목의 상세 페이지는 `/product/{n}` 에 있다.

_MULTI_SEARCH_PAGE = """
<div class="product-card">
  <span class="title">글렌피딕 12년</span>
  <a href="/product/1">보기</a>
</div>
<div class="product-card">
  <span class="title">글렌피딕 15년</span>
  <a href="/product/2">보기</a>
</div>
"""

_CONFIRM_SEARCH_PAGE = """
<div class="product-card">
  <span class="title">글렌피딕 21년 그란 레제르바</span>
  <a href="/product/1">보기</a>
</div>
"""

_NO_CANDIDATE_SEARCH_PAGE = """
<div class="product-card">
  <span class="title">글렌피딕 아이스 익스프레스</span>
  <a href="/product/1">보기</a>
</div>
<div class="product-card">
  <span class="title">조니워커 블랙</span>
  <a href="/product/2">보기</a>
</div>
"""


def _rank_card(name: str, index: int) -> str:
    return (
        f'<div class="product-card"><span class="title">{name}</span>'
        f'<a href="/product/{index}">보기</a></div>'
    )


_RANK_SEARCH_PAGE = "\n".join(
    _rank_card(name, index)
    for index, name in enumerate(
        [
            "글렌피딕 12년",
            "글렌피딕 15년",
            "글렌피딕 18년",
            "글렌피딕 21년",
            "글렌피딕 아이스 익스프레스",
            "조니워커 블랙",
        ],
        start=1,
    )
)


async def test_자동_채택_구간에서는_확인이_필요없고_후보도_함께_온다() -> None:
    # "글렌피딕 12년" vs "글렌피딕 15년" 유사도(difflib) 는 0.857 로 _AUTO_ACCEPT(0.85) 이상이다.
    transport = _transport(
        {"/search": (200, _MULTI_SEARCH_PAGE), "/product/2": (200, _DETAIL_PAGE_FULL)}
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 15년", transport=transport
    )

    assert result.ok is True
    assert result.needs_confirmation is False
    assert result.matched_name == "글렌피딕 15년"
    assert result.match_score is not None and result.match_score >= 0.85
    assert len(result.candidates) == 2


async def test_확인_필요_구간에서는_값과_함께_확인_요구를_반환한다() -> None:
    # "글렌피딕 12년" vs "글렌피딕 21년 그란 레제르바" 유사도는 0.6 으로 0.5~0.85 사이다.
    transport = _transport(
        {"/search": (200, _CONFIRM_SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)}
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.ok is True
    assert result.needs_confirmation is True
    assert result.matched_name == "글렌피딕 21년 그란 레제르바"
    assert result.fields == {"price": 35000.0, "rating": 4.5, "scale": 5}
    assert result.match_score is not None
    assert 0.5 <= result.match_score < 0.85


async def test_후보_없음_구간에서는_값_없이_후보만_반환한다() -> None:
    # 두 후보 모두 접두사 게이트는 통과하지만("글렌피딕" 이 앞 4글자로 겹치거나, 아예
    # 다른 이름이거나) 전체 유사도가 0.5 미만이라 "충분히 비슷한 후보 없음" 으로 처리된다.
    transport = _transport({"/search": (200, _NO_CANDIDATE_SEARCH_PAGE)})

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert result.ok is False
    assert result.fields == {}
    assert result.degraded is True
    assert len(result.candidates) == 2
    assert {c.name for c in result.candidates} == {"글렌피딕 아이스 익스프레스", "조니워커 블랙"}


async def test_후보는_점수_내림차순으로_최대_5개만_노출한다() -> None:
    # "글렌피딕 12년" 을 검색하므로 정확히 일치하는 item 1 이 최종 선택된다(score 1.0).
    transport = _transport(
        {"/search": (200, _RANK_SEARCH_PAGE), "/product/1": (200, _DETAIL_PAGE_FULL)}
    )

    result = await fetch_snapshot(
        ADAPTER_SPEC, base_url="https://example.com", query="글렌피딕 12년", transport=transport
    )

    assert len(result.candidates) == 5
    # 정확히 일치하는 후보가 가장 높은 점수로 맨 앞에 온다.
    assert result.candidates[0].name == "글렌피딕 12년"
    assert result.candidates[0].score == 1.0
    # 점수 내림차순 — 잘려 나간 마지막 후보(조니워커 블랙, 유사도 0)는 목록에 없다.
    scores = [c.score for c in result.candidates]
    assert scores == sorted(scores, reverse=True)
    assert "조니워커 블랙" not in {c.name for c in result.candidates}


async def test_고정하면_검색을_건너뛰고_상세를_바로_받는다() -> None:
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        if request.url.path == "/product/1":
            return httpx.Response(200, text=_DETAIL_PAGE_FULL)
        raise AssertionError(f"unexpected path: {request.url.path}")

    transport = httpx.MockTransport(handler)
    pinned = PinnedMatch(external_url="https://example.com/product/1")

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        query="아무 검색어(쓰이지 않아야 한다)",
        transport=transport,
        pinned=pinned,
    )

    assert result.ok is True
    assert result.fields == {"price": 35000.0, "rating": 4.5, "scale": 5}
    assert result.source_url == "https://example.com/product/1"
    assert result.candidates == []
    # 검색 페이지 요청이 한 번도 없어야 한다 — 있었다면 handler 가 AssertionError 로 실패했다.
    assert "/search" not in seen_paths


async def test_다른_호스트로_고정하면_거부한다() -> None:
    transport = _transport({"/product/1": (200, _DETAIL_PAGE_FULL)})
    pinned = PinnedMatch(external_url="https://evil.example/product/1")

    result = await fetch_snapshot(
        ADAPTER_SPEC,
        base_url="https://example.com",
        query="아무 검색어",
        transport=transport,
        pinned=pinned,
    )

    assert result.ok is False
    assert result.degraded is True
    assert result.warning is not None
    assert "밖" in result.warning


async def test_고정_ID_result_fields_모드에서는_URL_일치로_고른다() -> None:
    # 검색어("글렌피딕 12년")와의 유사도는 item 1(글렌피딕 12년, 1.0)이 item 2(발베니
    # 12년, 0.462)보다 훨씬 높지만, 고정된 URL 은 item 2 를 가리킨다 — 유사도를 무시하고
    # URL 이 일치하는 item 2 를 골라야 한다.
    body = json.dumps(
        {
            "results": [
                {"id": 1, "name": "글렌피딕 12년", "price": 35000, "review_rate": 4.5},
                {"id": 2, "name": "발베니 12년", "price": 45000, "review_rate": 4.2},
            ]
        }
    )
    transport = _transport({"/api/search": (200, body)})
    pinned = PinnedMatch(external_url="https://example.com/item/2")

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        query="글렌피딕 12년",
        transport=transport,
        pinned=pinned,
    )

    assert result.ok is True
    assert result.source_url == "https://example.com/item/2"
    assert result.fields == {"price": 45000, "rating": 4.2, "scale": 5}
    assert result.matched_name == "발베니 12년"
    assert result.needs_confirmation is False
    assert len(result.candidates) == 2


async def test_고정된_상품이_검색_결과에서_사라지면_후보만_반환하고_폴백하지_않는다() -> None:
    body = json.dumps(
        {"results": [{"id": 1, "name": "글렌피딕 12년", "price": 35000, "review_rate": 4.5}]}
    )
    transport = _transport({"/api/search": (200, body)})
    # item 1 만 검색 결과에 있는데, 고정은 이제 없는 item 999 를 가리킨다(상품 단종·개편 등).
    pinned = PinnedMatch(external_url="https://example.com/item/999")

    result = await fetch_snapshot(
        JSON_ADAPTER_SPEC,
        base_url="https://example.com",
        query="글렌피딕 12년",
        transport=transport,
        pinned=pinned,
    )

    assert result.ok is False
    assert result.fields == {}
    assert result.degraded is True
    assert result.warning is not None
    assert "찾지 못했습니다" in result.warning
    # 유사도로 대신 골라 주지 않는다 — 후보 목록만 준다.
    assert len(result.candidates) == 1
    assert result.candidates[0].name == "글렌피딕 12년"
