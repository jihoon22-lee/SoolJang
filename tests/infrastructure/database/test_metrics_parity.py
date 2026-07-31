"""순수 함수 구현과 SQL 구현의 결과 일치 검증.

같은 공식을 두 번 구현했으므로(성능 때문에) 갈라지면 화면과 API 가 다른 값을 보여준다.
이 테스트가 그것을 막는 유일한 장치다. 공식을 바꿀 때는 **반드시 양쪽을 함께** 고치고 이
테스트로 확인한다.
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import Row
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.domain.metrics import (
    BottleRecord,
    BottleState,
    PurchaseLot,
    compute_product_metrics,
)
from sooljang.infrastructure.database.metrics_sql import (
    product_metrics_query,
    single_product_metrics_query,
)
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Product,
    Purchase,
    Sku,
)
from sooljang.infrastructure.legacy.normalize import normalize_name_for_matching

pytestmark = pytest.mark.requires_db

#: SQL 은 Numeric(20,4) 로 계산하고 파이썬은 소수 둘째 자리로 반올림한다. 반올림 시점이
#: 달라 마지막 자리에서 1원 미만 차이가 날 수 있다.
TOLERANCE = Decimal("0.01")


def _assert_close(actual: object, expected: Decimal | None, label: str) -> None:
    if expected is None:
        assert actual is None, f"{label}: SQL={actual!r} 인데 순수 함수는 None"
        return
    assert actual is not None, f"{label}: SQL=None 인데 순수 함수는 {expected}"
    assert abs(Decimal(str(actual)) - expected) <= TOLERANCE, (
        f"{label}: SQL={actual} vs 순수 함수={expected}"
    )


async def _build(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    name: str,
    lots: list[tuple[int, int, str | None, str | None]],
    bottle_statuses: list[BottleStatus],
) -> tuple[uuid.UUID, list[PurchaseLot], list[BottleRecord]]:
    """DB 레코드와 순수 함수 입력을 같은 데이터로 만든다."""
    product = Product(
        user_id=user_id,
        name=name,
        normalized_name=normalize_name_for_matching(name),
    )
    session.add(product)
    await session.flush()

    domain_lots: list[PurchaseLot] = []
    skus: dict[int, Sku] = {}
    purchases: list[Purchase] = []

    for quantity, volume_ml, list_price, paid_price in lots:
        if volume_ml not in skus:
            sku = Sku(user_id=user_id, product_id=product.id, volume_ml=volume_ml)
            session.add(sku)
            await session.flush()
            skus[volume_ml] = sku
        purchase = Purchase(
            user_id=user_id,
            sku_id=skus[volume_ml].id,
            quantity=quantity,
            unit_list_price=Decimal(list_price) if list_price is not None else None,
            unit_paid_price=Decimal(paid_price) if paid_price is not None else None,
        )
        session.add(purchase)
        purchases.append(purchase)
        domain_lots.append(
            PurchaseLot(
                quantity=quantity,
                volume_ml=volume_ml,
                unit_list_price=Decimal(list_price) if list_price is not None else None,
                unit_paid_price=Decimal(paid_price) if paid_price is not None else None,
            )
        )
    await session.flush()

    # 병은 첫 구매 건에 몰아서 붙인다. 지표는 제품 수준 집계라 배치가 결과를 바꾸지 않는다.
    domain_bottles: list[BottleRecord] = []
    if purchases and bottle_statuses:
        for index, status in enumerate(bottle_statuses, start=1):
            session.add(
                Bottle(
                    user_id=user_id,
                    purchase_id=purchases[0].id,
                    label_no=index,
                    status=status,
                    remaining_ml=0 if status is BottleStatus.FINISHED else None,
                )
            )
            domain_bottles.append(BottleRecord(status.value))
        await session.flush()

    return product.id, domain_lots, domain_bottles


async def _sql_row(
    session: AsyncSession, user_id: uuid.UUID, product_id: uuid.UUID
) -> Row[tuple[object, ...]]:
    result = await session.execute(single_product_metrics_query(user_id, product_id))
    row = result.one()
    return row


async def _compare(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    name: str,
    lots: list[tuple[int, int, str | None, str | None]],
    bottle_statuses: list[BottleStatus],
) -> Row[tuple[object, ...]]:
    """같은 데이터에 대해 두 구현 결과를 비교하고 SQL 행을 반환한다."""
    product_id, domain_lots, domain_bottles = await _build(
        session, user_id, name=name, lots=lots, bottle_statuses=bottle_statuses
    )
    expected = compute_product_metrics(domain_lots, domain_bottles)
    row = await _sql_row(session, user_id, product_id)

    assert row.purchased_count == expected.prices.purchased_count, "구매 병수"
    assert row.priced_quantity == expected.prices.priced_quantity, "정가 있는 병수"
    assert row.paid_quantity == expected.prices.paid_quantity, "실구매가 있는 병수"
    _assert_close(row.list_total, expected.prices.list_total, "정가 총액")
    _assert_close(row.paid_total, expected.prices.paid_total, "실구매 총액")
    _assert_close(row.avg_list_price, expected.prices.avg_list_price, "평단가")
    _assert_close(row.avg_paid_price, expected.prices.avg_paid_price, "실평단가")
    _assert_close(row.price_per_100ml, expected.prices.price_per_100ml, "100ml당 가격")
    _assert_close(row.price_per_100ml_paid, expected.prices.price_per_100ml_paid, "100ml당 실가격")
    _assert_close(row.discount_rate, expected.prices.discount_rate, "할인율")
    assert int(row.total_volume_ml) == expected.prices.total_volume_ml, "총 용량"

    assert row.unopened == expected.bottles.unopened, "미개봉"
    assert row.open == expected.bottles.open, "개봉"
    assert row.finished == expected.bottles.finished, "소진"
    assert row.gifted == expected.bottles.gifted, "증여"
    assert row.sold == expected.bottles.sold, "판매"
    assert row.in_stock == expected.bottles.in_stock, "재고"
    _assert_close(row.inventory_value_at_cost, expected.inventory_value_at_cost, "재고 자산가치")
    return row


# --- 일치 검증 시나리오 -------------------------------------------------------


async def test_single_purchase_parity(session: AsyncSession, user_id: uuid.UUID) -> None:
    row = await _compare(
        session,
        user_id,
        name="단일 구매",
        lots=[(1, 750, "23980", "23980")],
        bottle_statuses=[BottleStatus.FINISHED],
    )

    assert Decimal(str(row.price_per_100ml)).quantize(Decimal("0.01")) == Decimal("3197.33")


async def test_multiple_purchases_parity(session: AsyncSession, user_id: uuid.UUID) -> None:
    """같은 술을 다른 가격에 여러 번 산 경우. 엑셀이 표현할 수 없던 상황이다."""
    await _compare(
        session,
        user_id,
        name="다중 구매",
        lots=[(2, 700, "100000", "90000"), (1, 700, "130000", "128000")],
        bottle_statuses=[BottleStatus.UNOPENED, BottleStatus.OPEN, BottleStatus.FINISHED],
    )


async def test_mixed_volume_parity(session: AsyncSession, user_id: uuid.UUID) -> None:
    """700ml 와 1000ml 가 섞이면 가중 평균이어야 한다."""
    await _compare(
        session,
        user_id,
        name="다중 용량",
        lots=[(1, 700, "70000", "70000"), (1, 1000, "80000", "80000")],
        bottle_statuses=[BottleStatus.UNOPENED, BottleStatus.UNOPENED],
    )


async def test_gift_purchase_parity(session: AsyncSession, user_id: uuid.UUID) -> None:
    """가격 없는 구매 건은 금액 집계에서 빠지고 병수에는 남아야 한다."""
    row = await _compare(
        session,
        user_id,
        name="선물 포함",
        lots=[(2, 900, None, None), (1, 900, "30000", "30000")],
        bottle_statuses=[BottleStatus.FINISHED, BottleStatus.FINISHED, BottleStatus.UNOPENED],
    )

    assert row.purchased_count == 3
    assert row.priced_quantity == 1


async def test_all_gift_parity_returns_null_not_zero(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """0 을 반환하면 '전부 무료' 와 '가격 정보 없음' 을 구분할 수 없다."""
    row = await _compare(
        session,
        user_id,
        name="전부 선물",
        lots=[(2, 900, None, None)],
        bottle_statuses=[BottleStatus.UNOPENED, BottleStatus.UNOPENED],
    )

    assert row.avg_list_price is None
    assert row.price_per_100ml is None
    assert row.discount_rate is None


async def test_list_price_only_parity(session: AsyncSession, user_id: uuid.UUID) -> None:
    row = await _compare(
        session,
        user_id,
        name="정가만",
        lots=[(1, 700, "50000", None)],
        bottle_statuses=[BottleStatus.UNOPENED],
    )

    assert row.avg_paid_price is None
    assert row.discount_rate is None


async def test_partial_price_discount_parity(session: AsyncSession, user_id: uuid.UUID) -> None:
    """할인율은 정가·실구매가가 모두 있는 구매 건만으로 계산해야 한다."""
    row = await _compare(
        session,
        user_id,
        name="부분 가격",
        lots=[(1, 700, "100000", "80000"), (1, 700, "100000", None)],
        bottle_statuses=[BottleStatus.UNOPENED, BottleStatus.UNOPENED],
    )

    assert Decimal(str(row.discount_rate)).quantize(Decimal("0.0001")) == Decimal("0.2000")


async def test_disposed_bottles_are_not_stock_parity(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    row = await _compare(
        session,
        user_id,
        name="증여 판매",
        lots=[(3, 700, "60000", "60000")],
        bottle_statuses=[BottleStatus.GIFTED, BottleStatus.SOLD, BottleStatus.UNOPENED],
    )

    assert row.in_stock == 1
    assert row.gifted == 1
    assert row.sold == 1


async def test_product_without_bottles_still_reports_price_metrics(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """임포트 직후처럼 구매 건만 있고 병이 없는 상태에서도 금액 지표는 보여야 한다."""
    product_id, _, _ = await _build(
        session,
        user_id,
        name="병 없음",
        lots=[(2, 700, "50000", "45000")],
        bottle_statuses=[],
    )

    row = await _sql_row(session, user_id, product_id)

    assert row.purchased_count == 2
    assert row.in_stock == 0
    assert Decimal(str(row.avg_paid_price)).quantize(Decimal("0.01")) == Decimal("45000.00")


async def test_metrics_query_scopes_by_user(
    session: AsyncSession, user_id: uuid.UUID, other_user_id: uuid.UUID
) -> None:
    await _build(
        session, user_id, name="내 술", lots=[(1, 700, "10000", "10000")], bottle_statuses=[]
    )
    await _build(
        session,
        other_user_id,
        name="남의 술",
        lots=[(1, 700, "20000", "20000")],
        bottle_statuses=[],
    )

    mine = (await session.execute(product_metrics_query(user_id))).all()
    theirs = (await session.execute(product_metrics_query(other_user_id))).all()

    assert len(mine) == 1
    assert len(theirs) == 1
    assert Decimal(str(mine[0].avg_list_price)) == Decimal(10000)
    assert Decimal(str(theirs[0].avg_list_price)) == Decimal(20000)


async def test_soft_deleted_purchase_is_excluded(session: AsyncSession, user_id: uuid.UUID) -> None:
    """soft delete 된 구매 건은 지표에서 빠져야 한다."""
    import datetime

    from sqlalchemy import select

    product_id, _, _ = await _build(
        session,
        user_id,
        name="삭제 제외",
        lots=[(1, 700, "10000", "10000"), (1, 700, "90000", "90000")],
        bottle_statuses=[],
    )

    expensive = await session.scalar(
        select(Purchase).where(Purchase.unit_list_price == Decimal(90000))
    )
    assert expensive is not None
    expensive.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()

    row = await _sql_row(session, user_id, product_id)

    assert row.purchased_count == 1
    assert Decimal(str(row.avg_list_price)) == Decimal(10000)


async def test_bottle_state_values_match_orm_enum() -> None:
    """도메인 계층이 ORM enum 을 import 하지 않으므로 값이 어긋날 수 있다."""
    assert BottleStatus.UNOPENED.value == BottleState.UNOPENED
    assert BottleStatus.OPEN.value == BottleState.OPEN
    assert BottleStatus.FINISHED.value == BottleState.FINISHED
    assert BottleStatus.GIFTED.value == BottleState.GIFTED
    assert BottleStatus.SOLD.value == BottleState.SOLD
