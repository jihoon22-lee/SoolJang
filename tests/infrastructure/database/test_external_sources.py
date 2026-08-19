"""외부 소스 레지스트리·온디맨드 조회 테스트(Task 18).

`lookup_product` 이 §7.3 준수 규칙(TTL 캐시 재사용, rate limit, `source_url` 없는 결과는
저장 거부)을 실제로 지키는지가 핵심이다. HTTP 는 `httpx.MockTransport` 로 흉내 낸다.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import NotFoundError
from sooljang.application.external_sources import (
    FAILING_THRESHOLD,
    PROBE_HISTORY_LIMIT,
    PinHostMismatchError,
    create_source,
    create_source_from_preset,
    delete_source,
    get_credential_hints,
    get_health,
    get_owned_source,
    list_sources,
    lookup_product,
    pin_match,
    probe_source,
    reset_rate_limit_history,
    set_credentials,
    unpin_match,
    update_source,
)
from sooljang.infrastructure.database.models import (
    Category,
    ExternalLookupCache,
    ExternalSourceProbe,
    Product,
)
from sooljang.infrastructure.external.adapter import reset_robots_cache
from sooljang.infrastructure.external.presets import get_preset

#: 유효한 Fernet 키 형태만 있으면 되므로 테스트마다 새로 만든다.
MASTER_KEY = Fernet.generate_key().decode()

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

#: 표준 필드 키로 값을 내보내는 스펙(Task 34 PR3). `price` 대신 `price_krw`, 그리고
#: 상수 `volume_ml` 을 함께 둬 100ml당 가격 계산까지 확인한다.
ADAPTER_SPEC_STANDARD = {
    "search": ADAPTER_SPEC["search"],
    "detail": {
        "fields": {
            "price_krw": {
                "selector": ".price",
                "attr": "text",
                "transform": ["strip_currency", "to_number"],
            },
            "volume_ml": {"const": 700},
        }
    },
}


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


class TestMatchPinning:
    """매칭 고정이 캐시·조회 경로에 미치는 영향(Task 34 PR1)."""

    async def test_고정하면_해당_소스_제품의_캐시를_버린다(
        self, session: AsyncSession, product: Product
    ) -> None:
        """고정을 바꾸면 캐시가 가리키던 상품 자체가 달라진다.

        남겨 두면 `ttl_hours`(기본 24시간) 동안 옛 상품 값을 계속 보여준다 — 고정을
        고친 이유가 바로 그것이므로 즉시 버려야 한다.
        """
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )
        cached_before = await session.scalars(
            select(ExternalLookupCache).where(ExternalLookupCache.product_id == product.id)
        )
        assert len(list(cached_before)) == 1

        await pin_match(
            session,
            user_id=USER_ID,
            source=source,
            product_id=product.id,
            external_url="https://example.com/product/1",
            external_name="글렌피딕 12년",
            external_key="1",
        )

        cached_after = await session.scalars(
            select(ExternalLookupCache).where(ExternalLookupCache.product_id == product.id)
        )
        assert list(cached_after) == []

    async def test_해제해도_캐시를_버린다(self, session: AsyncSession, product: Product) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            source=source,
            product_id=product.id,
            external_url="https://example.com/product/1",
            external_name="글렌피딕 12년",
            external_key="1",
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        removed = await unpin_match(session, source_id=source.id, product_id=product.id)

        cached = await session.scalars(
            select(ExternalLookupCache).where(ExternalLookupCache.product_id == product.id)
        )
        assert removed is True
        assert list(cached) == []

    async def test_고정된_소스는_조회에서_검색을_건너뛴다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await pin_match(
            session,
            user_id=USER_ID,
            source=source,
            product_id=product.id,
            external_url="https://example.com/product/1",
            external_name="글렌피딕 12년",
            external_key="1",
        )

        call_log: list[str] = []
        results = await lookup_product(
            session,
            user_id=USER_ID,
            product=product,
            transport=_found_transport(call_log),
        )

        assert results[0].pinned is True
        assert results[0].source_url == "https://example.com/product/1"
        assert "/search" not in call_log

    async def test_다른_호스트로_고정하면_거부한다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="데일리샷",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        with pytest.raises(PinHostMismatchError):
            await pin_match(
                session,
                user_id=USER_ID,
                source=source,
                product_id=product.id,
                external_url="https://evil.example.net/product/1",
                external_name="글렌피딕 12년",
            )


class TestNormalizedFields:
    """표준 필드 분류와 파생값(Task 34 PR3)."""

    async def test_표준_키_필드는_normalized로_분류되고_파생값이_계산된다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC_STANDARD,
        )

        results = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        assert results[0].normalized.price_krw == 35000
        assert results[0].normalized.volume_ml == 700
        assert results[0].normalized.price_per_100ml == Decimal("5000.00")

    async def test_캐시된_결과도_normalized가_채워진다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC_STANDARD,
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        cached = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        assert cached[0].cached is True
        assert cached[0].normalized.price_krw == 35000

    async def test_버전이_낮은_캐시_행은_TTL과_무관하게_다시_조회한다(
        self, session: AsyncSession, product: Product
    ) -> None:
        """표준 키 도입 이전 스냅샷(`version` 없음)은 TTL 이 남아 있어도 stale 로 본다 —
        `fields` 가 옛 자유 dict 모양이라 비교 뷰가 값을 못 잡기 때문이다."""
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        session.add(
            ExternalLookupCache(
                user_id=USER_ID,
                source_id=source.id,
                product_id=product.id,
                snapshot={
                    "source_url": "https://example.com/product/1",
                    "fields": {"price": 30000.0},
                    "raw_excerpt": None,
                    "matched_name": None,
                    "match_score": None,
                    "external_key": None,
                },
                degraded=False,
                warning=None,
                fetched_at=datetime.now(UTC),
            )
        )
        await session.flush()

        call_log: list[str] = []
        results = await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport(call_log)
        )

        assert results[0].cached is False
        assert len(call_log) > 0


class TestHealth:
    """소스 헬스 체크(Task 34 PR4). `external_lookup_cache` 는 성공한 조회만 담아
    실패 이력이 남는 곳이 없었다 — `external_source_probe` 가 그 공백을 메운다."""

    async def test_실제_조회는_헬스_로그에_남는다(
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

        health = await get_health(session, user_id=USER_ID)
        assert len(health) == 1
        assert health[0].source_id == source.id
        assert health[0].status == "healthy"
        assert health[0].consecutive_failures == 0
        assert health[0].last_success_at is not None

    async def test_캐시_적중은_새_헬스_기록을_남기지_않는다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )
        probes_after_first = list(await session.scalars(select(ExternalSourceProbe)))
        assert len(probes_after_first) == 1

        # 두 번째 조회는 캐시 적중이라 실제 시도가 아니다.
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        probes_after_second = list(await session.scalars(select(ExternalSourceProbe)))
        assert len(probes_after_second) == 1

    async def test_실패가_연속_3회_이상이면_failing(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        for _ in range(FAILING_THRESHOLD):
            await lookup_product(
                session, user_id=USER_ID, product=product, transport=_not_found_transport()
            )

        health = await get_health(session, user_id=USER_ID)
        assert health[0].source_id == source.id
        assert health[0].status == "failing"
        assert health[0].consecutive_failures == FAILING_THRESHOLD

    async def test_실패_2회는_failing이_아니라_degraded(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        for _ in range(FAILING_THRESHOLD - 1):
            await lookup_product(
                session, user_id=USER_ID, product=product, transport=_not_found_transport()
            )

        health = await get_health(session, user_id=USER_ID)
        assert health[0].status == "degraded"
        assert health[0].consecutive_failures == FAILING_THRESHOLD - 1

    async def test_실패_후_성공하면_연속_실패가_0으로_리셋된다(
        self, session: AsyncSession, product: Product
    ) -> None:
        await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_not_found_transport()
        )
        await lookup_product(
            session, user_id=USER_ID, product=product, transport=_found_transport()
        )

        health = await get_health(session, user_id=USER_ID)
        assert health[0].status == "healthy"
        assert health[0].consecutive_failures == 0

    async def test_이력이_20개를_넘으면_오래된_것부터_삭제된다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        # rate limit 이 롤링 로그 검증을 방해하지 않도록 충분히 넉넉하게 둔다.
        source.rate_limit_per_min = PROBE_HISTORY_LIMIT + 5
        await session.flush()

        for _ in range(PROBE_HISTORY_LIMIT + 3):
            await lookup_product(
                session, user_id=USER_ID, product=product, transport=_not_found_transport()
            )

        probes = list(await session.scalars(select(ExternalSourceProbe)))
        assert len(probes) == PROBE_HISTORY_LIMIT

    async def test_테스트_조회는_캐시에_저장하지_않지만_헬스_로그에는_남는다(
        self, session: AsyncSession
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        result = await probe_source(
            session, source=source, sample_name="글렌피딕 12년", transport=_found_transport()
        )

        assert result.ok is True
        cached_rows = list(await session.scalars(select(ExternalLookupCache)))
        assert cached_rows == []
        probes = list(await session.scalars(select(ExternalSourceProbe)))
        assert len(probes) == 1
        assert probes[0].ok is True

    async def test_소스_삭제시_probe_행이_cascade_삭제된다(
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

        await session.delete(source)
        await session.flush()

        probes = list(await session.scalars(select(ExternalSourceProbe)))
        assert probes == []

    async def test_등록만_하고_조회한_적_없으면_unknown(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        health = await get_health(session, user_id=USER_ID)

        assert health[0].source_id == source.id
        assert health[0].status == "unknown"
        assert health[0].last_success_at is None


class TestPresets:
    """프리셋 카탈로그 등록·자동 갱신(Task 34 PR5)."""

    async def test_프리셋으로_소스를_등록한다(self, session: AsyncSession) -> None:
        source = await create_source_from_preset(session, user_id=USER_ID, preset_key="dailyshot")

        assert source.name == "데일리샷"
        assert source.base_url == "https://dailyshot.co"
        assert source.preset_key == "dailyshot"
        assert source.preset_version == 1
        assert source.spec_overridden is False

    async def test_없는_프리셋_키는_거부한다(self, session: AsyncSession) -> None:
        with pytest.raises(NotFoundError):
            await create_source_from_preset(session, user_id=USER_ID, preset_key="존재하지-않음")

    async def test_이름을_지정하면_프리셋_이름_대신_쓴다(self, session: AsyncSession) -> None:
        source = await create_source_from_preset(
            session, user_id=USER_ID, preset_key="dailyshot", name="내 데일리샷"
        )
        assert source.name == "내 데일리샷"

    async def test_프리셋_소스의_스펙을_직접_고치면_spec_overridden이_된다(
        self, session: AsyncSession
    ) -> None:
        source = await create_source_from_preset(session, user_id=USER_ID, preset_key="dailyshot")

        await update_source(
            session, source, user_id=USER_ID, fields={"adapter_spec": {"search": {}}}
        )

        assert source.spec_overridden is True

    async def test_커스텀_소스는_스펙을_고쳐도_spec_overridden이_안된다(
        self, session: AsyncSession
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="커스텀",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        await update_source(
            session, source, user_id=USER_ID, fields={"adapter_spec": {"search": {}}}
        )

        assert source.spec_overridden is False

    async def test_프리셋_버전이_오르면_목록_조회시_자동_갱신된다(
        self, session: AsyncSession
    ) -> None:
        source = await create_source_from_preset(session, user_id=USER_ID, preset_key="dailyshot")
        # 구버전으로 되돌려 최신 카탈로그보다 낮게 만든다.
        source.preset_version = 0
        source.adapter_spec = {"search": {"url_template": "https://old.example.com/{query}"}}
        await session.flush()

        sources = await list_sources(session, user_id=USER_ID)

        preset = get_preset("dailyshot")
        assert preset is not None
        assert sources[0].preset_version == preset.version
        assert sources[0].adapter_spec == preset.adapter_spec

    async def test_spec_overridden이면_자동_갱신에서_제외된다(self, session: AsyncSession) -> None:
        source = await create_source_from_preset(session, user_id=USER_ID, preset_key="dailyshot")
        source.preset_version = 0
        source.spec_overridden = True
        await session.flush()

        sources = await list_sources(session, user_id=USER_ID)

        assert sources[0].preset_version == 0


#: 자격 증명 헤더 주입을 확인하는 스펙(Task 34 PR5).
_CREDENTIAL_ADAPTER_SPEC = {
    "search": {
        "url_template": "https://example.com/search?q={query}",
        "item": ".product-card",
        "fields": {
            "name": {"selector": ".title", "attr": "text"},
            "url": {"selector": "a", "attr": "href", "absolute": True},
        },
    },
    "detail": {"fields": {"price": {"selector": ".price", "attr": "text"}}},
    "credentials": [{"name": "api_key", "inject": {"type": "header", "key": "X-Api-Key"}}],
}


def _credential_capture_transport(captured: dict[str, str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=_ROBOTS_ALLOW_ALL)
        if request.url.path == "/search":
            captured.update(request.headers)
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


class TestCredentials:
    """자격 증명 암호화 저장과 요청 주입(Task 34 PR5)."""

    async def test_저장하면_힌트만_반환된다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )

        hints = await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-abcdef1234"},
            master_key=MASTER_KEY,
        )

        assert hints == {"api_key": "1234"}

    async def test_저장된_힌트를_다시_조회할_수_있다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-abcdef1234"},
            master_key=MASTER_KEY,
        )

        hints = await get_credential_hints(session, source_id=source.id)

        assert hints == {"api_key": "1234"}

    async def test_다시_저장하면_덮어쓴다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "old-0000"},
            master_key=MASTER_KEY,
        )

        hints = await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "new-9999"},
            master_key=MASTER_KEY,
        )

        assert hints == {"api_key": "9999"}
        assert await get_credential_hints(session, source_id=source.id) == {"api_key": "9999"}

    async def test_조회시_자격_증명이_헤더로_주입된다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=_CREDENTIAL_ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-abcdef1234"},
            master_key=MASTER_KEY,
        )
        captured: dict[str, str] = {}

        await lookup_product(
            session,
            user_id=USER_ID,
            product=product,
            transport=_credential_capture_transport(captured),
            master_key=MASTER_KEY,
        )

        assert captured.get("x-api-key") == "sk-abcdef1234"

    async def test_master_key가_없으면_자격_증명을_주입하지_않는다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=_CREDENTIAL_ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-abcdef1234"},
            master_key=MASTER_KEY,
        )
        captured: dict[str, str] = {}

        result = await lookup_product(
            session,
            user_id=USER_ID,
            product=product,
            transport=_credential_capture_transport(captured),
        )

        assert "x-api-key" not in captured
        assert result[0].degraded is False

    async def test_테스트_조회에도_자격_증명이_주입된다(self, session: AsyncSession) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=_CREDENTIAL_ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-abcdef1234"},
            master_key=MASTER_KEY,
        )
        captured: dict[str, str] = {}

        await probe_source(
            session,
            source=source,
            sample_name="글렌피딕 12년",
            transport=_credential_capture_transport(captured),
            master_key=MASTER_KEY,
        )

        assert captured.get("x-api-key") == "sk-abcdef1234"

    async def test_자격_증명_값이_경고_메시지에_나타나지_않는다(
        self, session: AsyncSession, product: Product
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=_CREDENTIAL_ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-super-secret-999"},
            master_key=MASTER_KEY,
        )

        results = await lookup_product(
            session,
            user_id=USER_ID,
            product=product,
            transport=_not_found_transport(),
            master_key=MASTER_KEY,
        )

        assert results[0].warning is not None
        assert "sk-super-secret-999" not in (results[0].warning or "")
        assert "sk-super-secret-999" not in str(results[0].fields)

    async def test_자격_증명_값이_로그에_나타나지_않는다(
        self, session: AsyncSession, product: Product, caplog: pytest.LogCaptureFixture
    ) -> None:
        source = await create_source(
            session,
            user_id=USER_ID,
            name="전역 소스",
            base_url="https://example.com",
            adapter_spec=_CREDENTIAL_ADAPTER_SPEC,
        )
        await set_credentials(
            session,
            user_id=USER_ID,
            source_id=source.id,
            values={"api_key": "sk-super-secret-999"},
            master_key=MASTER_KEY,
        )

        with caplog.at_level("DEBUG"):
            await lookup_product(
                session,
                user_id=USER_ID,
                product=product,
                transport=_credential_capture_transport({}),
                master_key=MASTER_KEY,
            )

        assert "sk-super-secret-999" not in caplog.text
