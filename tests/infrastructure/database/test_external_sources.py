"""외부 소스 레지스트리·온디맨드 조회 테스트(Task 18).

`lookup_product` 이 §7.3 준수 규칙(TTL 캐시 재사용, rate limit, `source_url` 없는 결과는
저장 거부)을 실제로 지키는지가 핵심이다. HTTP 는 `httpx.MockTransport` 로 흉내 낸다.

`TestMatchPin` 은 매칭 고정(Task 34 PR1, §7.4) — `pin_match`/`unpin_match` 가 소유권·호스트를
검증하고, 캐시를 지우고, `lookup_product` 가 실제로 검색을 건너뛰는지를 확인한다.
"""

import uuid

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import NotFoundError, ValidationFailedError
from sooljang.application.external_sources import (
    create_source,
    delete_source,
    get_match,
    get_owned_source,
    list_sources,
    lookup_product,
    pin_match,
    reset_rate_limit_history,
    unpin_match,
    update_source,
)
from sooljang.infrastructure.database.models import (
    Category,
    ExternalLookupCache,
    ExternalProductMatch,
    ExternalSource,
    Product,
)
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


def _detail_fails_transport() -> httpx.MockTransport:
    """후보는 찾지만(그래서 `source_url` 은 채워지지만) 상세 페이지 조회가 실패한다."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        if request.url.path == "/search":
            query = request.url.params.get("q", "")
            body = (
                '<div class="product-card">'
                f'<span class="title">{query}</span>'
                '<a href="/product/1">보기</a>'
                "</div>"
            )
            return httpx.Response(200, text=body)
        if request.url.path == "/product/1":
            return httpx.Response(500, text="internal error")
        raise AssertionError(f"unexpected path: {request.url.path}")

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

    async def test_존재하지_않는_카테고리로_등록하면_거부한다(self, session: AsyncSession) -> None:
        with pytest.raises(NotFoundError):
            await create_source(
                session,
                user_id=USER_ID,
                name="데일리샷",
                base_url="https://example.com",
                adapter_spec=ADAPTER_SPEC,
                category_id=uuid.uuid4(),
            )

    async def test_다른_사용자의_카테고리로_등록하면_거부한다(
        self, session: AsyncSession, category: Category
    ) -> None:
        with pytest.raises(NotFoundError):
            await create_source(
                session,
                user_id=OTHER_USER_ID,
                name="데일리샷",
                base_url="https://example.com",
                adapter_spec=ADAPTER_SPEC,
                category_id=category.id,
            )

    async def test_수정하면_이름과_주소의_앞뒤_공백을_지운다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        updated = await update_source(
            session,
            source,
            user_id=USER_ID,
            fields={"name": "  새 이름  ", "base_url": "  https://new.example.com  "},
        )

        assert updated.name == "새 이름"
        assert updated.base_url == "https://new.example.com"

    async def test_수정시_존재하지_않는_카테고리면_거부한다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(NotFoundError):
            await update_source(
                session, source, user_id=USER_ID, fields={"category_id": uuid.uuid4()}
            )

    async def test_수정시_다른_사용자의_카테고리면_거부한다(
        self, session: AsyncSession, category: Category
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(NotFoundError):
            await update_source(
                session, source, user_id=OTHER_USER_ID, fields={"category_id": category.id}
            )


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

    async def test_상세_페이지_조회가_실패하면_출처_URL이_있어도_캐시에_저장하지_않는다(
        self, session: AsyncSession, product: Product
    ) -> None:
        # 후보는 찾아 source_url 은 채워지지만 상세 페이지 자체를 못 가져온 경우다.
        # `source_url` 만 보고 캐시하면 이 실패가 TTL 동안 성공인 것처럼 굳어 버린다.
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        first = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_detail_fails_transport()
        )
        second = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_detail_fails_transport()
        )

        assert first[0].source_url == "https://example.com/product/1"
        assert first[0].degraded is True
        # 캐시에 안 남았으니 두 번째 호출도 다시 시도한다(cached=False).
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


class TestMatchPin:
    async def test_고정하면_매칭이_생긴다(self, session: AsyncSession, product: Product) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        match = await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="글렌피딕 12년 고정",
        )

        assert match.external_url == "https://example.com/product/1"
        assert match.external_name == "글렌피딕 12년 고정"
        assert match.external_key is None

    async def test_다시_고정하면_그_자리에서_바뀐다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="첫 고정",
        )

        second = await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/2",
            external_name="다시 고정",
        )

        rows = list(await session.scalars(select(ExternalProductMatch)))
        assert len(rows) == 1
        assert second.external_url == "https://example.com/product/2"
        assert second.external_name == "다시 고정"

    async def test_다른_호스트로_고정하면_거부한다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(ValidationFailedError):
            await pin_match(
                session,
                user_id=USER_ID,
                product_id=product.id,
                source_id=source.id,
                external_url="https://evil.example/product/1",
                external_name="가짜",
            )

    async def test_없는_제품에_고정하면_404(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(NotFoundError):
            await pin_match(
                session,
                user_id=USER_ID,
                product_id=uuid.uuid4(),
                source_id=source.id,
                external_url="https://example.com/product/1",
                external_name="X",
            )

    async def test_없는_소스에_고정하면_404(self, session: AsyncSession, product: Product) -> None:
        with pytest.raises(NotFoundError):
            await pin_match(
                session,
                user_id=USER_ID,
                product_id=product.id,
                source_id=uuid.uuid4(),
                external_url="https://example.com/product/1",
                external_name="X",
            )

    async def test_다른_사용자의_소스에는_고정할_수_없다(
        self, session: AsyncSession, product: Product
    ) -> None:
        other_source = await create_source(
            session,
            user_id=OTHER_USER_ID,
            name="다른 사용자 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(NotFoundError):
            await pin_match(
                session,
                user_id=USER_ID,
                product_id=product.id,
                source_id=other_source.id,
                external_url="https://example.com/product/1",
                external_name="X",
            )

    async def test_해제하면_없어진다(self, session: AsyncSession, product: Product) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="X",
        )

        await unpin_match(session, user_id=USER_ID, product_id=product.id, source_id=source.id)

        assert (
            await get_match(session, user_id=USER_ID, source_id=source.id, product_id=product.id)
            is None
        )

    async def test_없는_고정을_해제하면_404(self, session: AsyncSession, product: Product) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(NotFoundError):
            await unpin_match(session, user_id=USER_ID, product_id=product.id, source_id=source.id)

    async def test_고정하면_기존_캐시가_지워진다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )
        assert len(list(await session.scalars(select(ExternalLookupCache)))) == 1

        await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="X",
        )

        assert list(await session.scalars(select(ExternalLookupCache))) == []

    async def test_해제하면_캐시도_지워진다(self, session: AsyncSession, product: Product) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="X",
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )
        assert len(list(await session.scalars(select(ExternalLookupCache)))) == 1

        await unpin_match(session, user_id=USER_ID, product_id=product.id, source_id=source.id)

        assert list(await session.scalars(select(ExternalLookupCache))) == []

    async def test_고정된_조회는_검색을_건너뛴다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="고정된 이름",
        )
        call_log: list[str] = []

        results = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport(call_log)
        )

        assert "/search" not in call_log
        assert results[0].pinned is True
        assert results[0].matched_name == "고정된 이름"
        assert results[0].needs_confirmation is False
        assert results[0].fields == {"price": 35000.0}

    async def test_소스를_삭제하면_고정도_함께_지워진다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            product_id=product.id,
            source_id=source.id,
            external_url="https://example.com/product/1",
            external_name="X",
        )
        await session.flush()

        # `delete_source` 는 소프트 삭제라 FK CASCADE 를 트리거하지 않는다 — 실제 행
        # 삭제를 확인하려면 하드 삭제해야 한다.
        await session.execute(delete(ExternalSource).where(ExternalSource.id == source.id))
        await session.flush()

        rows = list(await session.scalars(select(ExternalProductMatch)))
        assert rows == []
