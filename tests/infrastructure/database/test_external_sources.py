"""외부 소스 레지스트리·온디맨드 조회 테스트(Task 18).

`lookup_product` 이 §7.3 준수 규칙(TTL 캐시 재사용, rate limit, `source_url` 없는 결과는
저장 거부)을 실제로 지키는지가 핵심이다. HTTP 는 `httpx.MockTransport` 로 흉내 낸다.
"""

import uuid

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.external_sources import (
    create_source,
    delete_source,
    get_owned_source,
    list_sources,
    lookup_product,
    reset_rate_limit_history,
)
from sooljang.infrastructure.database.models import Category, ExternalLookupCache, Product
from sooljang.infrastructure.external.adapter import reset_robots_cache

USER_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")
OTHER_USER_ID = uuid.UUID("00000000-0000-0000-0000-0000000000bb")

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
        }
    },
}
_ROBOTS_ALLOW_ALL = "User-agent: *\nAllow: /"


@pytest.fixture(autouse=True)
def _reset_module_state() -> None:
    """소스별 rate limit·robots.txt 캐시가 테스트 간에 새지 않게 한다."""
    reset_rate_limit_history()
    reset_robots_cache()


@pytest_asyncio.fixture
async def category(session: AsyncSession) -> Category:
    category = Category(user_id=USER_ID, name="위스키", slug="whisky", sort_order=1)
    session.add(category)
    await session.flush()
    return category


@pytest_asyncio.fixture
async def product(session: AsyncSession, category: Category) -> Product:
    product = Product(
        user_id=USER_ID,
        name="글렌피딕 12년",
        normalized_name="글렌피딕12년",
        category_id=category.id,
    )
    session.add(product)
    await session.flush()
    return product


def _found_transport(call_log: list[str] | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if call_log is not None:
            call_log.append(request.url.path)
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        if request.url.path == "/search":
            # 검색어를 후보 이름으로 그대로 반사한다 — 유사도 판정이 항상 통과하게 해
            # 이 mock 은 "제품명이 무엇이든 찾아진다" 는 경우만 흉내 낸다.
            query = request.url.params.get("q", "")
            body = (
                '<div class="product-card">'
                f'<span class="title">{query}</span>'
                '<a href="/product/1">보기</a>'
                "</div>"
            )
            return httpx.Response(200, text=body)
        if request.url.path == "/product/1":
            return httpx.Response(200, text='<div class="price">35,000원</div>')
        raise AssertionError(f"unexpected path: {request.url.path}")

    return httpx.MockTransport(handler)


def _not_found_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        return httpx.Response(200, text="<div>결과 없음</div>")

    return httpx.MockTransport(handler)


class TestRegistry:
    async def test_소스를_등록하고_목록에서_본다(self, session: AsyncSession) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        sources = await list_sources(session, user_id=USER_ID)

        assert [s.name for s in sources] == ["데일리샷"]

    async def test_다른_사용자의_소스는_보이지_않는다(self, session: AsyncSession) -> None:
        await create_source(
            session,
            user_id=OTHER_USER_ID,
            name="다른 사용자 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        assert await list_sources(session, user_id=USER_ID) == []

    async def test_get_owned_source는_다른_사용자_소스에_None을_반환한다(
        self, session: AsyncSession
    ) -> None:
        source = await create_source(
            session,
            user_id=OTHER_USER_ID,
            name="다른 사용자 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        assert await get_owned_source(session, user_id=USER_ID, source_id=source.id) is None

    async def test_삭제하면_목록에서_빠진다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        await delete_source(session, source)
        await session.flush()

        assert await list_sources(session, user_id=USER_ID) == []


class TestLookup:
    async def test_활성_소스가_없으면_빈_목록을_반환한다(
        self, session: AsyncSession, product: Product
    ) -> None:
        results = await lookup_product(session, user_id=USER_ID, product=product)
        assert results == []

    async def test_비활성_소스는_건너뛴다(self, session: AsyncSession, product: Product) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="비활성 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
            is_active=False,
        )

        results = await lookup_product(session, user_id=USER_ID, product=product)

        assert results == []

    async def test_다른_주종에_scope된_소스는_건너뛴다(
        self, session: AsyncSession, product: Product
    ) -> None:
        other_category = Category(user_id=USER_ID, name="맥주", slug="beer", sort_order=2)
        session.add(other_category)
        await session.flush()
        await create_source(
            session,
            user_id=USER_ID,
            name="맥주 전용 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
            category_id=other_category.id,
        )

        results = await lookup_product(session, user_id=USER_ID, product=product)

        assert results == []

    async def test_전역_소스는_모든_주종에_적용된다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        results = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        assert len(results) == 1
        assert results[0].source_url == "https://example.com/product/1"
        assert results[0].fields == {"price": 35000.0}
        assert results[0].degraded is False
        assert results[0].cached is False

    async def test_성공한_조회는_캐시에_저장되고_재조회시_네트워크를_다시_타지_않는다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        call_log: list[str] = []

        first = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport(call_log)
        )
        assert first[0].cached is False
        calls_after_first = len(call_log)
        assert calls_after_first > 0

        second = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport(call_log)
        )

        assert second[0].cached is True
        assert second[0].source_url == "https://example.com/product/1"
        assert second[0].fields == {"price": 35000.0}
        # 캐시가 재사용됐으니 두 번째 호출에서 네트워크 요청이 추가되지 않는다.
        assert len(call_log) == calls_after_first

        cached_rows = list(await session.scalars(select(ExternalLookupCache)))
        assert len(cached_rows) == 1

    async def test_출처_URL이_없는_결과는_캐시에_저장하지_않는다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        first = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_not_found_transport()
        )
        second = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_not_found_transport()
        )

        assert first[0].source_url is None
        assert first[0].degraded is True
        # 캐시에 안 남았으니 두 번째 호출도 여전히 cached=False(다시 시도)다.
        assert second[0].cached is False

        cached_rows = list(await session.scalars(select(ExternalLookupCache)))
        assert cached_rows == []

    async def test_요청_한도를_초과하면_소스를_건너뛰고_경고를_남긴다(
        self, session: AsyncSession, category: Category
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
            rate_limit_per_min=1,
        )
        product_a = Product(
            user_id=USER_ID, name="술 A", normalized_name="술a", category_id=category.id
        )
        product_b = Product(
            user_id=USER_ID, name="술 B", normalized_name="술b", category_id=category.id
        )
        session.add_all([product_a, product_b])
        await session.flush()

        first = await lookup_product(
            session, user_id=USER_ID, product=product_a, transport=_found_transport()
        )
        second = await lookup_product(
            session, user_id=USER_ID, product=product_b, transport=_found_transport()
        )

        assert first[0].degraded is False
        assert second[0].degraded is True
        assert second[0].source_url is None
        assert second[0].warning is not None
        assert "한도" in second[0].warning
