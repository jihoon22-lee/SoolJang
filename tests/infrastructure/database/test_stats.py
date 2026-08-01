"""통계 대시보드 집계 검증 (`application/stats.py`).

DB 를 직접 쓰는 함수라 `tests/application/` 이 아니라 `tests/infrastructure/database/` 의
`session`/`user_id` fixture 를 쓴다(`test_categories.py`·`test_metrics_parity.py` 와 같은
배치 관례).
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.categories import create_category
from sooljang.application.stats import (
    UNCATEGORIZED_LABEL,
    get_category_rollup,
    get_rankings,
    get_summary,
)
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Product,
    Purchase,
    Sku,
    Vendor,
    VendorKind,
)
from sooljang.infrastructure.legacy.normalize import normalize_name_for_matching

pytestmark = pytest.mark.requires_db


async def _add_product(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    name: str,
    category_id: uuid.UUID | None = None,
    abv: str | None = None,
    personal_rating: str | None = None,
    volume_ml: int = 700,
    quantity: int = 1,
    unit_list_price: str | None = None,
    unit_paid_price: str | None = None,
    vendor_id: uuid.UUID | None = None,
    bottle_statuses: list[BottleStatus] | None = None,
) -> uuid.UUID:
    product = Product(
        user_id=user_id,
        name=name,
        normalized_name=normalize_name_for_matching(name),
        category_id=category_id,
        abv=Decimal(abv) if abv is not None else None,
        personal_rating=Decimal(personal_rating) if personal_rating is not None else None,
    )
    session.add(product)
    await session.flush()

    sku = Sku(user_id=user_id, product_id=product.id, volume_ml=volume_ml)
    session.add(sku)
    await session.flush()

    purchase = Purchase(
        user_id=user_id,
        sku_id=sku.id,
        vendor_id=vendor_id,
        quantity=quantity,
        unit_list_price=Decimal(unit_list_price) if unit_list_price is not None else None,
        unit_paid_price=Decimal(unit_paid_price) if unit_paid_price is not None else None,
    )
    session.add(purchase)
    await session.flush()

    for index, status in enumerate((bottle_statuses or []), start=1):
        session.add(
            Bottle(
                user_id=user_id,
                purchase_id=purchase.id,
                label_no=index,
                status=status,
                remaining_ml=0 if status is BottleStatus.FINISHED else None,
            )
        )
    await session.flush()
    return product.id


# --- 랭킹 --------------------------------------------------------------------


async def test_rankings_order_by_expected_basis(session: AsyncSession, user_id: uuid.UUID) -> None:
    """병당 가격·총 구매액은 실구매가 기준, 100ml당 가격은 정가 기준으로 정렬돼야 한다.

    엑셀 실측 랭킹 블록과 대조해 확정한 기준이다(`application/stats.py` 모듈 docstring).
    """
    await _add_product(
        session,
        user_id,
        name="비쌈",
        quantity=1,
        unit_list_price="100000",
        unit_paid_price="90000",
    )
    await _add_product(
        session,
        user_id,
        name="쌈",
        quantity=1,
        unit_list_price="50000",
        unit_paid_price="95000",
    )

    rankings = await get_rankings(session, user_id=user_id, limit=10)

    # 실구매 기준: "쌈"(95000)이 "비쌈"(90000)보다 위에 온다.
    assert [e.product_name for e in rankings.by_bottle_price] == ["쌈", "비쌈"]
    assert [e.product_name for e in rankings.by_total_spend] == ["쌈", "비쌈"]
    # 정가 기준: "비쌈"(100000)이 "쌈"(50000)보다 위에 온다.
    assert [e.product_name for e in rankings.by_price_per_100ml] == ["비쌈", "쌈"]


async def test_rankings_exclude_products_without_the_metric(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """가격·평점이 없는 제품은 해당 랭킹에서 빠져야 한다."""
    await _add_product(session, user_id, name="선물", quantity=1)
    await _add_product(session, user_id, name="평점만", personal_rating="5.0", quantity=1)

    rankings = await get_rankings(session, user_id=user_id, limit=10)

    assert rankings.by_bottle_price == []
    assert rankings.by_total_spend == []
    assert [e.product_name for e in rankings.by_personal_rating] == ["평점만"]


async def test_rankings_tie_break_by_id_is_stable(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """같은 값이면 새로고침마다 순서가 바뀌지 않도록 id 로 순서를 고정한다."""
    ids = [
        await _add_product(session, user_id, name=f"동점{i}", quantity=1, unit_list_price="10000")
        for i in range(3)
    ]

    first = await get_rankings(session, user_id=user_id, limit=10)
    second = await get_rankings(session, user_id=user_id, limit=10)

    first_order = [e.product_id for e in first.by_price_per_100ml]
    second_order = [e.product_id for e in second.by_price_per_100ml]
    assert first_order == second_order
    assert set(first_order) == set(ids)


async def test_rankings_respect_limit(session: AsyncSession, user_id: uuid.UUID) -> None:
    for i in range(5):
        await _add_product(
            session,
            user_id,
            name=f"제품{i}",
            quantity=1,
            unit_list_price=str(10000 + i),
            unit_paid_price=str(10000 + i),
        )

    rankings = await get_rankings(session, user_id=user_id, limit=2)
    assert len(rankings.by_bottle_price) == 2


# --- 주종별 집계 ---------------------------------------------------------------


async def test_category_rollup_groups_to_top_level_ancestor(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """손자 카테고리의 제품도 최상위 주종으로 롤업돼야 한다."""
    liquor = await create_category(session, user_id=user_id, name="양주")
    whisky = await create_category(session, user_id=user_id, name="위스키", parent_id=liquor.id)
    single_malt = await create_category(
        session, user_id=user_id, name="싱글몰트", parent_id=whisky.id
    )
    wine = await create_category(session, user_id=user_id, name="와인")

    await _add_product(
        session,
        user_id,
        name="글렌알라키",
        category_id=single_malt.id,
        quantity=1,
        unit_list_price="80000",
        unit_paid_price="80000",
    )
    await _add_product(
        session,
        user_id,
        name="레드와인",
        category_id=wine.id,
        quantity=2,
        unit_list_price="30000",
        unit_paid_price="30000",
    )
    await _add_product(session, user_id, name="미분류술", quantity=1)

    stats = await get_category_rollup(session, user_id=user_id)
    by_name = {stat.name: stat for stat in stats}

    assert by_name["양주"].bottle_count == 1
    assert by_name["양주"].category_id == liquor.id
    assert by_name["와인"].bottle_count == 2
    assert by_name[UNCATEGORIZED_LABEL].bottle_count == 1
    assert by_name[UNCATEGORIZED_LABEL].category_id is None


async def test_category_rollup_totals_and_averages(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    beer = await create_category(session, user_id=user_id, name="맥주")
    await _add_product(
        session,
        user_id,
        name="맥주A",
        category_id=beer.id,
        abv="5.0",
        personal_rating="4.0",
        volume_ml=500,
        quantity=2,
        unit_list_price="3000",
        unit_paid_price="2700",
    )
    await _add_product(
        session,
        user_id,
        name="맥주B",
        category_id=beer.id,
        abv="7.0",
        personal_rating="5.0",
        volume_ml=500,
        quantity=1,
        unit_list_price="4000",
        unit_paid_price="4000",
    )

    [beer_stat] = await get_category_rollup(session, user_id=user_id)

    assert beer_stat.bottle_count == 3
    assert beer_stat.total_spend == Decimal("10000.00")  # 정가 총액: 3000*2 + 4000
    assert beer_stat.avg_abv == Decimal("6.0000")  # (5.0 + 7.0) / 2, 제품 단위 단순 평균
    assert beer_stat.avg_rating == Decimal("4.5000")


async def test_category_rollup_empty_when_no_products(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    assert await get_category_rollup(session, user_id=user_id) == []


# --- 전체 합계 -----------------------------------------------------------------


async def test_summary_matches_manual_totals(session: AsyncSession, user_id: uuid.UUID) -> None:
    vendor_a = Vendor(user_id=user_id, name="가게A", kind=VendorKind.BOTTLE_SHOP)
    vendor_b = Vendor(user_id=user_id, name="가게B", kind=VendorKind.MART)
    session.add_all([vendor_a, vendor_b])
    await session.flush()

    await _add_product(
        session,
        user_id,
        name="제품1",
        quantity=2,
        volume_ml=750,
        unit_list_price="20000",
        unit_paid_price="18000",
        vendor_id=vendor_a.id,
        bottle_statuses=[BottleStatus.FINISHED, BottleStatus.UNOPENED],
    )
    await _add_product(
        session,
        user_id,
        name="제품2(선물)",
        quantity=1,
        volume_ml=500,
        vendor_id=vendor_b.id,
        bottle_statuses=[BottleStatus.OPEN],
    )

    summary = await get_summary(session, user_id=user_id)

    assert summary.purchased_count == 3
    assert summary.consumed_count == 1
    assert summary.unopened_count == 1
    assert summary.opened_count == 1
    assert summary.total_volume_ml == 2 * 750 + 500
    assert summary.list_total == Decimal("40000.00")  # 가격 없는 구매 건은 금액 집계에서 제외
    assert summary.paid_total == Decimal("36000.00")
    # 평균의 분모는 전체 병수(3)다 — 가격이 없는 선물 병도 "컬렉션 전체 평균"에는 들어간다.
    # 제품별 지표(`ProductMetricsOut.avg_list_price`)의 분모(가격 있는 병수)와는 다른 기준이다.
    assert summary.avg_list_price == Decimal("13333.33")
    assert summary.avg_paid_price == Decimal("12000.00")
    assert summary.vendor_count == 2


async def test_summary_empty_collection_returns_null_money_not_zero(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """레코드가 하나도 없으면 금액은 0이 아니라 None이어야 한다(§5-D35)."""
    summary = await get_summary(session, user_id=user_id)

    assert summary.purchased_count == 0
    assert summary.list_total is None
    assert summary.avg_list_price is None
    assert summary.vendor_count == 0


async def test_summary_scopes_by_user(
    session: AsyncSession, user_id: uuid.UUID, other_user_id: uuid.UUID
) -> None:
    await _add_product(
        session, user_id, name="내 술", quantity=1, unit_list_price="10000", unit_paid_price="10000"
    )
    await _add_product(
        session,
        other_user_id,
        name="남의 술",
        quantity=1,
        unit_list_price="99999",
        unit_paid_price="99999",
    )

    summary = await get_summary(session, user_id=user_id)
    assert summary.purchased_count == 1
    assert summary.list_total == Decimal("10000.00")
