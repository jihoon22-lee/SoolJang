"""제품·규격·구매 건·개별 병 모델 테스트.

핵심은 **같은 제품에 서로 다른 구매처·가격의 구매 건을 각각 기록할 수 있다**는 것이다.
엑셀에서 불가능했던 이 기록이 이 프로젝트의 존재 이유다(`docs/legacy-schema.md` §6).
"""

import datetime
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.categories import create_category
from sooljang.infrastructure.database.models import (
    IN_STOCK_STATUSES,
    Bottle,
    BottleStatus,
    Producer,
    Product,
    ProductVariety,
    Purchase,
    Sku,
    Variety,
    Vendor,
    VendorKind,
)
from sooljang.infrastructure.legacy.normalize import normalize_name_for_matching

pytestmark = pytest.mark.requires_db


async def _product(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    name: str = "가상 증류소 싱글몰트 12y",
    vintage: int | None = None,
    abv: Decimal | None = Decimal("46.0"),
) -> Product:
    product = Product(
        user_id=user_id,
        name=name,
        normalized_name=normalize_name_for_matching(name),
        vintage=vintage,
        abv=abv,
    )
    session.add(product)
    await session.flush()
    return product


async def _sku(
    session: AsyncSession, user_id: uuid.UUID, product: Product, volume_ml: int = 700
) -> Sku:
    sku = Sku(user_id=user_id, product_id=product.id, volume_ml=volume_ml)
    session.add(sku)
    await session.flush()
    return sku


async def _vendor(
    session: AsyncSession, user_id: uuid.UUID, name: str, kind: VendorKind = VendorKind.MART
) -> Vendor:
    vendor = Vendor(user_id=user_id, name=name, kind=kind)
    session.add(vendor)
    await session.flush()
    return vendor


async def _purchase(
    session: AsyncSession,
    user_id: uuid.UUID,
    sku: Sku,
    vendor: Vendor | None,
    *,
    quantity: int,
    unit_list: Decimal | None,
    unit_paid: Decimal | None,
    purchased_on: datetime.date | None = None,
) -> Purchase:
    purchase = Purchase(
        user_id=user_id,
        sku_id=sku.id,
        vendor_id=vendor.id if vendor else None,
        quantity=quantity,
        unit_list_price=unit_list,
        unit_paid_price=unit_paid,
        purchased_on=purchased_on,
    )
    session.add(purchase)
    await session.flush()
    for index in range(1, quantity + 1):
        session.add(
            Bottle(
                user_id=user_id,
                purchase_id=purchase.id,
                label_no=index,
                status=BottleStatus.UNOPENED,
            )
        )
    await session.flush()
    return purchase


# --- 엑셀 한계 해결 (핵심 데모) -----------------------------------------------


async def test_same_product_records_separate_purchases_with_different_vendors_and_prices(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    mart = await _vendor(session, user_id, "가상마트 1호점")
    shop = await _vendor(session, user_id, "가상보틀샵", VendorKind.BOTTLE_SHOP)

    first = await _purchase(
        session,
        user_id,
        sku,
        mart,
        quantity=2,
        unit_list=Decimal(120000),
        unit_paid=Decimal(100000),
        purchased_on=datetime.date(2026, 3, 1),
    )
    second = await _purchase(
        session,
        user_id,
        sku,
        shop,
        quantity=1,
        unit_list=Decimal(130000),
        unit_paid=Decimal(128000),
        purchased_on=datetime.date(2026, 6, 15),
    )

    purchases = (await session.scalars(select(Purchase).where(Purchase.sku_id == sku.id))).all()

    assert len(purchases) == 2
    assert {p.vendor_id for p in purchases} == {mart.id, shop.id}
    assert {p.unit_paid_price for p in purchases} == {Decimal("100000.00"), Decimal("128000.00")}
    assert {p.purchased_on for p in purchases} == {
        datetime.date(2026, 3, 1),
        datetime.date(2026, 6, 15),
    }
    # 총 3병이 개별 레코드로 존재한다.
    bottle_count = await session.scalar(
        select(func.count())
        .select_from(Bottle)
        .where(Bottle.purchase_id.in_([first.id, second.id]))
    )
    assert bottle_count == 3


async def test_multiple_volumes_are_distinct_skus(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """같은 술의 700ml 와 1L 는 다른 규격이다. 바코드와 단위 가격이 달라진다."""
    product = await _product(session, user_id)
    small = await _sku(session, user_id, product, 700)
    large = await _sku(session, user_id, product, 1000)

    assert small.id != large.id
    skus = (await session.scalars(select(Sku).where(Sku.product_id == product.id))).all()
    assert {sku.volume_ml for sku in skus} == {700, 1000}


async def test_duplicate_volume_for_same_product_is_rejected(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    await _sku(session, user_id, product, 700)

    session.add(Sku(user_id=user_id, product_id=product.id, volume_ml=700))
    with pytest.raises(IntegrityError):
        await session.flush()


# --- 제약 검증 ---------------------------------------------------------------


@pytest.mark.parametrize("abv", [Decimal("-1"), Decimal("100.5")])
async def test_abv_outside_range_is_rejected(
    session: AsyncSession, user_id: uuid.UUID, abv: Decimal
) -> None:
    session.add(Product(user_id=user_id, name="범위 밖", normalized_name="범위 밖", abv=abv))
    with pytest.raises(IntegrityError):
        await session.flush()


@pytest.mark.parametrize("rating", [Decimal("0"), Decimal("6.5")])
async def test_personal_rating_outside_six_point_scale_is_rejected(
    session: AsyncSession, user_id: uuid.UUID, rating: Decimal
) -> None:
    session.add(
        Product(user_id=user_id, name="평점 밖", normalized_name="평점 밖", personal_rating=rating)
    )
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_vintage_outside_range_is_rejected(session: AsyncSession, user_id: uuid.UUID) -> None:
    session.add(
        Product(user_id=user_id, name="빈티지 밖", normalized_name="빈티지 밖", vintage=1700)
    )
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_non_positive_volume_is_rejected(session: AsyncSession, user_id: uuid.UUID) -> None:
    product = await _product(session, user_id)
    session.add(Sku(user_id=user_id, product_id=product.id, volume_ml=0))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_non_positive_quantity_is_rejected(session: AsyncSession, user_id: uuid.UUID) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    session.add(Purchase(user_id=user_id, sku_id=sku.id, quantity=0))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_foreign_price_requires_fx_rate(session: AsyncSession, user_id: uuid.UUID) -> None:
    """환율 없이 외화 가격만 저장하면 원화 환산을 재현할 수 없다."""
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    session.add(
        Purchase(
            user_id=user_id,
            sku_id=sku.id,
            quantity=1,
            currency="USD",
            foreign_unit_price=Decimal("46.67"),
        )
    )
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_foreign_purchase_with_fx_rate_is_accepted(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    purchase = Purchase(
        user_id=user_id,
        sku_id=sku.id,
        quantity=1,
        currency="USD",
        foreign_unit_price=Decimal("46.67"),
        fx_rate=Decimal("1431.9"),
        unit_paid_price=Decimal("66815.79"),
    )
    session.add(purchase)
    await session.flush()

    assert purchase.fx_rate == Decimal("1431.900000")


# --- 병 상태 제약 -------------------------------------------------------------


async def test_unopened_bottle_cannot_have_opened_date(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    purchase = await _purchase(
        session, user_id, sku, None, quantity=1, unit_list=None, unit_paid=None
    )
    bottle = (await session.scalars(select(Bottle).where(Bottle.purchase_id == purchase.id))).one()

    bottle.opened_on = datetime.date(2026, 5, 1)
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_finished_bottle_must_have_zero_remaining(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    purchase = await _purchase(
        session, user_id, sku, None, quantity=1, unit_list=None, unit_paid=None
    )
    bottle = (await session.scalars(select(Bottle).where(Bottle.purchase_id == purchase.id))).one()

    bottle.status = BottleStatus.FINISHED
    bottle.remaining_ml = 100
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_finished_date_cannot_precede_opened_date(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    purchase = await _purchase(
        session, user_id, sku, None, quantity=1, unit_list=None, unit_paid=None
    )
    bottle = (await session.scalars(select(Bottle).where(Bottle.purchase_id == purchase.id))).one()

    bottle.status = BottleStatus.OPEN
    bottle.opened_on = datetime.date(2026, 6, 1)
    bottle.finished_on = datetime.date(2026, 5, 1)
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_bottle_label_numbers_are_unique_within_a_purchase(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    purchase = await _purchase(
        session, user_id, sku, None, quantity=2, unit_list=None, unit_paid=None
    )

    session.add(Bottle(user_id=user_id, purchase_id=purchase.id, label_no=1))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_in_stock_statuses_exclude_gifted_and_sold() -> None:
    assert {BottleStatus.UNOPENED, BottleStatus.OPEN} == IN_STOCK_STATUSES
    assert BottleStatus.GIFTED not in IN_STOCK_STATUSES
    assert BottleStatus.SOLD not in IN_STOCK_STATUSES


async def test_counts_as_stock_property(session: AsyncSession, user_id: uuid.UUID) -> None:
    product = await _product(session, user_id)
    sku = await _sku(session, user_id, product)
    purchase = await _purchase(
        session, user_id, sku, None, quantity=1, unit_list=None, unit_paid=None
    )
    bottle = (await session.scalars(select(Bottle).where(Bottle.purchase_id == purchase.id))).one()

    assert bottle.counts_as_stock is True
    bottle.status = BottleStatus.GIFTED
    assert bottle.counts_as_stock is False


# --- 식별·중복 --------------------------------------------------------------


async def test_duplicate_product_identity_is_rejected(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """같은 이름·빈티지·도수는 한 제품이다. 임포트가 중복을 만들지 않게 한다."""
    await _product(session, user_id, name="가상 샤토", vintage=2015, abv=Decimal("13.0"))

    with pytest.raises(IntegrityError):
        await _product(session, user_id, name="가상 샤토", vintage=2015, abv=Decimal("13.0"))


async def test_same_name_different_vintage_is_a_separate_product(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    first = await _product(session, user_id, name="가상 샤토", vintage=2015)
    second = await _product(session, user_id, name="가상 샤토", vintage=2019)

    assert first.id != second.id


async def test_barcode_is_unique_per_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    first = await _product(session, user_id, name="첫째")
    second = await _product(session, user_id, name="둘째")
    session.add(Sku(user_id=user_id, product_id=first.id, volume_ml=700, barcode="8801234567890"))
    await session.flush()

    session.add(Sku(user_id=user_id, product_id=second.id, volume_ml=700, barcode="8801234567890"))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_multiple_skus_without_barcode_are_allowed(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """바코드가 없는 규격은 여러 개 있을 수 있다. NULL 은 유일성 대상이 아니다."""
    first = await _product(session, user_id, name="첫째")
    second = await _product(session, user_id, name="둘째")
    await _sku(session, user_id, first)
    await _sku(session, user_id, second)

    count = await session.scalar(select(func.count()).select_from(Sku))
    assert count == 2


async def test_vendor_name_is_unique_per_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    await _vendor(session, user_id, "가상마트")

    session.add(Vendor(user_id=user_id, name="가상마트"))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_product_varieties_support_multiple_values(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """레거시 41행이 셀 내 개행으로 여러 품종을 담고 있었다."""
    product = await _product(session, user_id)
    for order, name in enumerate(["Trappist Ale", "Quadrupel"]):
        variety = Variety(user_id=user_id, name=name)
        session.add(variety)
        await session.flush()
        session.add(
            ProductVariety(
                user_id=user_id, product_id=product.id, variety_id=variety.id, sort_order=order
            )
        )
    await session.flush()

    links = (
        await session.scalars(select(ProductVariety).where(ProductVariety.product_id == product.id))
    ).all()
    assert len(links) == 2


async def test_product_can_reference_category_and_producer(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    category = await create_category(session, user_id=user_id, name="싱글몰트 위스키")
    producer = Producer(user_id=user_id, name="가상 증류소", country="스코틀랜드")
    session.add(producer)
    await session.flush()

    product = await _product(session, user_id)
    product.category_id = category.id
    product.producer_id = producer.id
    await session.flush()

    loaded = await session.get(Product, product.id)
    assert loaded is not None
    assert loaded.category_id == category.id
    assert loaded.producer_id == producer.id
