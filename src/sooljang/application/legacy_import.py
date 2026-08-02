"""레거시 임포트 실행.

`import_plan.ImportPlan` 을 DB 에 적재한다. dry-run 과 실제 적재가 **같은 계획**을 쓰므로
미리 본 것과 다른 결과가 나오지 않는다.

멱등성이 핵심이다. 같은 파일을 두 번 넣어도 제품·규격·구매 건이 중복되지 않아야 한다.
사용자가 실수로 두 번 누르는 일은 반드시 생기고, 그때 429행이 858행이 되면 복구가 어렵다.
"""

import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.categories import create_category, load_tree
from sooljang.application.import_plan import ImportPlan, PlannedProduct, PlannedPurchase
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Category,
    Product,
    ProductVariety,
    Purchase,
    Sku,
    Variety,
    Vendor,
    VendorKind,
)

#: 구매처 이름에서 종류를 추정하는 규칙. 실측 82곳을 기준으로 정했다.
#: 맞히지 못하면 `other` 로 두고 사용자가 나중에 고친다. 틀린 분류를 강제하지 않는다.
_VENDOR_KIND_HINTS: tuple[tuple[tuple[str, ...], VendorKind], ...] = (
    (("면세",), VendorKind.DUTY_FREE),
    (("선물", "카카오톡"), VendorKind.GIFT),
    (("메가쇼", "박람회", "쇼", "페어", "KIBEX"), VendorKind.EVENT),
    (("마트", "코스트코", "트레이더스", "이마트", "에브리데이"), VendorKind.MART),
    (("보틀샵", "리쿼", "와인앤모어", "스타보틀", "와인백", "와인픽스"), VendorKind.BOTTLE_SHOP),
    (("브루", "양조장", "브루잉"), VendorKind.BREWERY),
    (("펍", "바", "창고"), VendorKind.BAR),
    (("온라인", "스마트오더", "데일리샷", "비타트라", "GS25", "위클리"), VendorKind.ONLINE),
)


def guess_vendor_kind(name: str) -> VendorKind:
    """구매처 이름으로 종류를 추정한다."""
    for keywords, kind in _VENDOR_KIND_HINTS:
        if any(keyword in name for keyword in keywords):
            return kind
    return VendorKind.OTHER


@dataclass(slots=True)
class ImportResult:
    """적재 결과. dry-run 예상과 대조할 수 있게 같은 항목을 센다."""

    products_created: int = 0
    products_reused: int = 0
    skus_created: int = 0
    purchases_created: int = 0
    purchases_skipped: int = 0
    bottles_created: int = 0
    categories_created: int = 0
    vendors_created: int = 0
    varieties_created: int = 0
    failed_rows: list[tuple[int, str]] = field(default_factory=list)

    @property
    def failed_count(self) -> int:
        return len(self.failed_rows)


class _Registry:
    """임포트 중 재사용할 참조를 모아 둔다. 행마다 다시 조회하면 429번 왕복한다."""

    def __init__(self) -> None:
        self.categories: dict[tuple[str, ...], uuid.UUID] = {}
        self.vendors: dict[str, uuid.UUID] = {}
        self.varieties: dict[str, uuid.UUID] = {}
        self.products: dict[tuple[str, int | None, Decimal | None], uuid.UUID] = {}
        self.skus: dict[tuple[uuid.UUID, int], uuid.UUID] = {}


async def _load_registry(session: AsyncSession, user_id: uuid.UUID) -> _Registry:
    registry = _Registry()

    for node in await load_tree(session, user_id):
        registry.categories[node.path] = node.id

    for vendor in await session.scalars(
        select(Vendor).where(Vendor.user_id == user_id, Vendor.deleted_at.is_(None))
    ):
        registry.vendors[vendor.name] = vendor.id

    for variety in await session.scalars(
        select(Variety).where(Variety.user_id == user_id, Variety.deleted_at.is_(None))
    ):
        registry.varieties[variety.name] = variety.id

    for product in await session.scalars(
        select(Product).where(Product.user_id == user_id, Product.deleted_at.is_(None))
    ):
        registry.products[(product.normalized_name, product.vintage, product.abv)] = product.id

    for sku in await session.scalars(
        select(Sku).where(Sku.user_id == user_id, Sku.deleted_at.is_(None))
    ):
        registry.skus[(sku.product_id, sku.volume_ml)] = sku.id

    return registry


async def apply_plan(
    session: AsyncSession, *, user_id: uuid.UUID, plan: ImportPlan
) -> ImportResult:
    """계획을 적재한다. 실패한 행은 건너뛰고 리포트에 남긴다.

    한 행의 문제로 전체를 되돌리면 429행 중 428행이 정상인데도 아무것도 얻지 못한다.
    """
    result = ImportResult()
    registry = await _load_registry(session, user_id)

    for planned in plan.products:
        savepoint = await session.begin_nested()
        try:
            await _apply_product(session, user_id, planned, registry, result)
            await savepoint.commit()
        except Exception as error:  # noqa: BLE001 - 행 단위로 격리하는 것이 목적이다
            await savepoint.rollback()
            result.failed_rows.append((planned.line_number, str(error)))

    await session.flush()

    # 한 요청에서 수백 행을 한꺼번에 넣는 유일한 경로다(레거시 시트 실측 429행,
    # `docs/legacy-schema.md` §5). autovacuum 의 ANALYZE 는 보통 수십 초~1분 뒤에나
    # 돌기 때문에, 방금 넣은 데이터를 곧바로 조회하면 플래너가 옛 통계(빈 테이블
    # 기준)로 `user_id` 선택도를 오판해 해시 조인 대신 중첩 루프를 고르고, 서브쿼리가
    # 행마다 재실행돼 수십 배 느려진다(Task 21 에서 429행 기준 25~30초로 실측). 적재
    # 직후 통계를 갱신해 이 창을 없앤다.
    for table in (
        "category",
        "vendor",
        "variety",
        "product",
        "product_variety",
        "sku",
        "purchase",
        "bottle",
    ):
        await session.execute(text(f"ANALYZE {table}"))

    return result


async def _apply_product(
    session: AsyncSession,
    user_id: uuid.UUID,
    planned: PlannedProduct,
    registry: _Registry,
    result: ImportResult,
) -> None:
    category_id = (
        await _ensure_category(session, user_id, planned.category_path, registry, result)
        if planned.category_path
        else None
    )

    product_id = registry.products.get(planned.identity)
    if product_id is None:
        product = Product(
            user_id=user_id,
            name=planned.name,
            normalized_name=planned.normalized_name,
            category_id=category_id,
            abv=planned.abv,
            vintage=planned.vintage,
            personal_rating=planned.personal_rating,
            note=planned.note,
            import_note=f"레거시 {planned.line_number}행",
        )
        session.add(product)
        await session.flush()
        product_id = product.id
        registry.products[planned.identity] = product_id
        result.products_created += 1
        await _link_varieties(session, user_id, product_id, planned, registry, result)
    else:
        result.products_reused += 1

    sku_id: uuid.UUID | None = None
    if planned.volume_ml is not None:
        key = (product_id, planned.volume_ml)
        sku_id = registry.skus.get(key)
        if sku_id is None:
            sku = Sku(user_id=user_id, product_id=product_id, volume_ml=planned.volume_ml)
            session.add(sku)
            await session.flush()
            sku_id = sku.id
            registry.skus[key] = sku_id
            result.skus_created += 1

    if sku_id is None:
        # 용량이 없으면 규격을 만들 수 없어 구매 건도 붙일 수 없다. 제품만 남긴다.
        return

    for index, purchase in enumerate(planned.purchases, start=1):
        await _apply_purchase(session, user_id, sku_id, planned, purchase, index, registry, result)


async def _apply_purchase(
    session: AsyncSession,
    user_id: uuid.UUID,
    sku_id: uuid.UUID,
    planned: PlannedProduct,
    purchase: PlannedPurchase,
    part_index: int,
    registry: _Registry,
    result: ImportResult,
) -> None:
    """구매 건과 병을 만든다.

    멱등성은 `import_note` 의 출처 표시로 판정한다. 레거시에 구매일이 없어 (sku, 구매처, 병수)
    만으로는 정상적인 중복 구매와 재실행을 구분할 수 없다. 출처 행 번호를 남기면 같은 행에서
    온 구매 건인지 확실히 알 수 있다.

    **조각 순번을 함께 넣는다.** 한 행에 같은 구매처가 두 번 나오는 경우가 실측에 있다
    (`스타보틀 인계 * 3 / 스타보틀 인계 * 1`). 순번이 없으면 두 번째 조각이 재실행으로
    오인되어 건너뛰어지고 병수가 하나 줄어든다.
    """
    origin = f"레거시 {planned.line_number}행"
    marker = f"{origin} #{part_index} · {purchase.vendor_name or '구매처 미기록'}"

    existing = await session.scalar(
        select(Purchase.id).where(
            Purchase.user_id == user_id,
            Purchase.sku_id == sku_id,
            Purchase.import_note.like(f"{marker}%"),
            Purchase.deleted_at.is_(None),
        )
    )
    if existing is not None:
        result.purchases_skipped += 1
        return

    vendor_id = (
        await _ensure_vendor(session, user_id, purchase.vendor_name, registry, result)
        if purchase.vendor_name
        else None
    )

    note_parts = [marker]
    if purchase.import_note:
        note_parts.append(f"원문: {purchase.import_note}")

    record = Purchase(
        user_id=user_id,
        sku_id=sku_id,
        vendor_id=vendor_id,
        quantity=purchase.quantity,
        unit_list_price=purchase.unit_list_price,
        unit_paid_price=purchase.unit_paid_price,
        currency=purchase.currency,
        fx_rate=purchase.fx_rate,
        foreign_unit_price=purchase.foreign_unit_price,
        discount_note=purchase.discount_note,
        import_note=" | ".join(note_parts),
    )
    session.add(record)
    await session.flush()
    result.purchases_created += 1

    label_no = 1
    for status, count in (
        (BottleStatus.FINISHED, purchase.finished),
        (BottleStatus.OPEN, purchase.opened),
        (BottleStatus.UNOPENED, purchase.unopened),
    ):
        for _ in range(count):
            session.add(
                Bottle(
                    user_id=user_id,
                    purchase_id=record.id,
                    label_no=label_no,
                    status=status,
                    # 소진 병은 잔량 0 이어야 한다는 제약을 만족시킨다.
                    remaining_ml=0 if status is BottleStatus.FINISHED else None,
                )
            )
            label_no += 1
            result.bottles_created += 1
    await session.flush()


async def _ensure_category(
    session: AsyncSession,
    user_id: uuid.UUID,
    path: tuple[str, ...],
    registry: _Registry,
    result: ImportResult,
) -> uuid.UUID:
    """계층 경로를 따라가며 없는 노드를 만든다. 부모가 먼저 있어야 자식을 만들 수 있다."""
    parent_id: uuid.UUID | None = None
    for depth in range(1, len(path) + 1):
        prefix = path[:depth]
        existing = registry.categories.get(prefix)
        if existing is None:
            category = await create_category(
                session, user_id=user_id, name=prefix[-1], parent_id=parent_id
            )
            registry.categories[prefix] = category.id
            result.categories_created += 1
            existing = category.id
        parent_id = existing
    assert parent_id is not None
    return parent_id


async def _ensure_vendor(
    session: AsyncSession,
    user_id: uuid.UUID,
    name: str,
    registry: _Registry,
    result: ImportResult,
) -> uuid.UUID:
    existing = registry.vendors.get(name)
    if existing is not None:
        return existing
    vendor = Vendor(user_id=user_id, name=name, kind=guess_vendor_kind(name))
    session.add(vendor)
    await session.flush()
    registry.vendors[name] = vendor.id
    result.vendors_created += 1
    return vendor.id


async def _link_varieties(
    session: AsyncSession,
    user_id: uuid.UUID,
    product_id: uuid.UUID,
    planned: PlannedProduct,
    registry: _Registry,
    result: ImportResult,
) -> None:
    for order, name in enumerate(planned.variety_names):
        variety_id = registry.varieties.get(name)
        if variety_id is None:
            variety = Variety(user_id=user_id, name=name)
            session.add(variety)
            await session.flush()
            variety_id = variety.id
            registry.varieties[name] = variety_id
            result.varieties_created += 1
        session.add(
            ProductVariety(
                user_id=user_id,
                product_id=product_id,
                variety_id=variety_id,
                sort_order=order,
            )
        )
    if planned.variety_names:
        await session.flush()


async def category_seed_count(session: AsyncSession, user_id: uuid.UUID) -> int:
    """현재 카테고리 수. 임포트 전후 비교에 쓴다."""
    rows = await session.scalars(
        select(Category.id).where(Category.user_id == user_id, Category.deleted_at.is_(None))
    )
    return len(list(rows))
