"""제품 라우터."""

import uuid
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Query, status
from sqlalchemy import select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.pagination import (
    Cursor,
    SortOrder,
    apply_cursor,
    normalize_limit,
)
from sooljang.api.schemas.product import (
    ProductCreate,
    ProductMetricsOut,
    ProductOut,
    ProductPage,
    ProductUpdate,
    SkuCreate,
    SkuOut,
)
from sooljang.application.products import (
    ProductFilters,
    SortKey,
    build_product_query,
    category_path_map,
    ensure_category_exists,
    load_product,
    metrics_from_row,
    normalized_name_of,
    producer_name_map,
    resolve_variety_ids,
    sort_column_for,
)
from sooljang.infrastructure.database.metrics_sql import single_product_metrics_query
from sooljang.infrastructure.database.models import Product, ProductVariety, Sku

router = APIRouter(prefix="/products", tags=["products"])


def _to_out(
    product: Product,
    *,
    metrics: dict[str, Any],
    category_paths: dict[uuid.UUID, list[str]],
    producer_names: dict[uuid.UUID, str],
) -> ProductOut:
    return ProductOut(
        id=product.id,
        name=product.name,
        name_en=product.name_en,
        category_id=product.category_id,
        category_path=category_paths.get(product.category_id, []) if product.category_id else [],
        producer_id=product.producer_id,
        producer_name=producer_names.get(product.producer_id) if product.producer_id else None,
        country=product.country,
        region=product.region,
        abv=product.abv,
        vintage=product.vintage,
        age_years=product.age_years,
        personal_rating=product.personal_rating,
        note=product.note,
        varieties=[link.variety.name for link in product.varieties],
        skus=[SkuOut.model_validate(sku) for sku in product.skus if sku.deleted_at is None],
        metrics=ProductMetricsOut(**metrics),
    )


@router.get("", response_model=ProductPage, summary="제품 목록 조회")
async def list_products(  # noqa: PLR0913 - 필터가 많은 것이 이 엔드포인트의 목적이다
    session: SessionDep,
    user_id: UserDep,
    q: Annotated[str | None, Query(description="이름 부분 문자열 검색 (한글 지원)")] = None,
    category_id: Annotated[uuid.UUID | None, Query(description="하위 주종 포함")] = None,
    include_descendants: Annotated[bool, Query()] = True,
    country: Annotated[str | None, Query()] = None,
    abv_min: Annotated[Decimal | None, Query(ge=0, le=100)] = None,
    abv_max: Annotated[Decimal | None, Query(ge=0, le=100)] = None,
    vintage_min: Annotated[int | None, Query(ge=1800, le=2200)] = None,
    vintage_max: Annotated[int | None, Query(ge=1800, le=2200)] = None,
    rating_min: Annotated[Decimal | None, Query(gt=0, le=6)] = None,
    in_stock: Annotated[bool | None, Query(description="재고 유무")] = None,
    vendor_id: Annotated[uuid.UUID | None, Query()] = None,
    variety: Annotated[str | None, Query(description="품종·스타일 부분 일치")] = None,
    price_per_100ml_min: Annotated[Decimal | None, Query(ge=0)] = None,
    price_per_100ml_max: Annotated[Decimal | None, Query(ge=0)] = None,
    sort: Annotated[SortKey, Query(description="정렬 키")] = "name",
    order: Annotated[SortOrder, Query()] = "asc",
    limit: Annotated[int | None, Query(ge=1, le=200)] = None,
    cursor: Annotated[str | None, Query(description="이전 응답의 next_cursor")] = None,
) -> ProductPage:
    """필터·검색·정렬을 적용한 제품 목록.

    모든 필터는 AND 로 결합된다. 페이지네이션은 커서 방식이며, `limit + 1` 개를 읽어
    다음 페이지 존재를 판단한다. 별도 COUNT 쿼리를 돌리지 않는다.
    """
    page_size = normalize_limit(limit)
    filters = ProductFilters(
        q=q,
        category_id=category_id,
        include_descendants=include_descendants,
        country=country,
        abv_min=abv_min,
        abv_max=abv_max,
        vintage_min=vintage_min,
        vintage_max=vintage_max,
        rating_min=rating_min,
        in_stock=in_stock,
        vendor_id=vendor_id,
        variety=variety,
        price_per_100ml_min=price_per_100ml_min,
        price_per_100ml_max=price_per_100ml_max,
    )

    statement, metrics = await build_product_query(session, user_id=user_id, filters=filters)
    sort_col = sort_column_for(sort, metrics)
    statement = apply_cursor(
        statement,
        sort_column=sort_col,
        id_column=Product.id,
        cursor=Cursor.decode(cursor) if cursor else None,
        order=order,
    ).limit(page_size + 1)

    rows = (await session.execute(statement)).all()
    category_paths = await category_path_map(session, user_id)
    producer_names = await producer_name_map(session, user_id)

    has_more = len(rows) > page_size
    visible = rows[:page_size]

    items = [
        _to_out(
            row[0],
            metrics=metrics_from_row(row),
            category_paths=category_paths,
            producer_names=producer_names,
        )
        for row in visible
    ]

    next_cursor = None
    if has_more and visible:
        last_row = visible[-1]
        product: Product = last_row[0]
        sort_value = (
            getattr(product, sort, None)
            if sort in {"name", "created_at", "updated_at", "abv", "vintage", "personal_rating"}
            else getattr(last_row, _metric_attr(sort), None)
        )
        next_cursor = Cursor(sort_value=sort_value, id=product.id).encode()

    return ProductPage(items=items, next_cursor=next_cursor)


def _metric_attr(sort: SortKey) -> str:
    return {
        "avg_list_price": "avg_list_price",
        "avg_paid_price": "avg_paid_price",
        "price_per_100ml": "price_per_100ml",
        "paid_total": "paid_total",
        "in_stock_count": "in_stock",
        "purchased_count": "purchased_count",
    }[sort]


@router.post(
    "", response_model=ProductOut, status_code=status.HTTP_201_CREATED, summary="제품 등록"
)
async def create_product(
    payload: ProductCreate, session: SessionDep, user_id: UserDep
) -> ProductOut:
    """제품을 등록한다. 규격과 품종을 함께 만들 수 있다.

    4계층 구조의 입력 부담을 줄이려면 한 번의 요청으로 제품·규격·품종을 만들 수 있어야 한다.
    """
    await ensure_category_exists(session, user_id=user_id, category_id=payload.category_id)

    product = Product(
        user_id=user_id,
        name=payload.name.strip(),
        name_en=payload.name_en,
        normalized_name=normalized_name_of(payload.name),
        category_id=payload.category_id,
        producer_id=payload.producer_id,
        country=payload.country,
        region=payload.region,
        abv=payload.abv,
        vintage=payload.vintage,
        age_years=payload.age_years,
        personal_rating=payload.personal_rating,
        note=payload.note,
    )
    session.add(product)
    await session.flush()

    await _replace_varieties(session, user_id, product, payload.variety_names)
    for sku in payload.skus:
        session.add(_new_sku(user_id, product.id, sku))
    await session.flush()

    return await _detail(session, user_id, product.id)


@router.get("/{product_id}", response_model=ProductOut, summary="제품 상세 조회")
async def get_product(product_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> ProductOut:
    return await _detail(session, user_id, product_id)


@router.patch("/{product_id}", response_model=ProductOut, summary="제품 수정")
async def update_product(
    product_id: uuid.UUID, payload: ProductUpdate, session: SessionDep, user_id: UserDep
) -> ProductOut:
    product = await load_product(session, user_id=user_id, product_id=product_id)

    if payload.category_id is not None:
        await ensure_category_exists(session, user_id=user_id, category_id=payload.category_id)

    fields = payload.model_dump(exclude_unset=True, exclude={"variety_names"})
    for key, value in fields.items():
        setattr(product, key, value)
    if "name" in fields and fields["name"]:
        product.normalized_name = normalized_name_of(fields["name"])

    if payload.variety_names is not None:
        await _replace_varieties(session, user_id, product, payload.variety_names)

    await session.flush()
    return await _detail(session, user_id, product_id)


@router.delete(
    "/{product_id}", status_code=status.HTTP_204_NO_CONTENT, summary="제품 삭제 (soft delete)"
)
async def delete_product(product_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    """soft delete 한다. 복구 가능해야 실수로 지운 기록을 되살릴 수 있다."""
    import datetime

    product = await load_product(session, user_id=user_id, product_id=product_id)
    product.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()


@router.post(
    "/{product_id}/skus",
    response_model=SkuOut,
    status_code=status.HTTP_201_CREATED,
    summary="규격 추가",
)
async def add_sku(
    product_id: uuid.UUID, payload: SkuCreate, session: SessionDep, user_id: UserDep
) -> SkuOut:
    await load_product(session, user_id=user_id, product_id=product_id)
    sku = _new_sku(user_id, product_id, payload)
    session.add(sku)
    await session.flush()
    return SkuOut.model_validate(sku)


def _new_sku(user_id: uuid.UUID, product_id: uuid.UUID, payload: SkuCreate) -> Sku:
    return Sku(
        user_id=user_id,
        product_id=product_id,
        volume_ml=payload.volume_ml,
        barcode=payload.barcode,
        barcode_type=payload.barcode_type,
        package_note=payload.package_note,
    )


async def _replace_varieties(
    session: SessionDep, user_id: uuid.UUID, product: Product, names: list[str]
) -> None:
    """품종 연결을 새 목록으로 교체한다."""
    existing = await session.scalars(
        select(ProductVariety).where(ProductVariety.product_id == product.id)
    )
    for link in existing:
        await session.delete(link)
    await session.flush()

    variety_ids = await resolve_variety_ids(session, user_id=user_id, names=names)
    for order, variety_id in enumerate(variety_ids):
        session.add(
            ProductVariety(
                user_id=user_id,
                product_id=product.id,
                variety_id=variety_id,
                sort_order=order,
            )
        )
    await session.flush()
    # 관계 컬렉션이 이미 로드되어 있으면 낡은 값이 남는다. 만료시켜 다음 조회가 다시 읽게 한다.
    session.expire(product, ["varieties"])


async def _detail(session: SessionDep, user_id: uuid.UUID, product_id: uuid.UUID) -> ProductOut:
    product = await load_product(session, user_id=user_id, product_id=product_id)
    row = (await session.execute(single_product_metrics_query(user_id, product_id))).first()
    category_paths = await category_path_map(session, user_id)
    producer_names = await producer_name_map(session, user_id)
    return _to_out(
        product,
        metrics=metrics_from_row(row),
        category_paths=category_paths,
        producer_names=producer_names,
    )


@router.get("/{product_id}/metrics", response_model=ProductMetricsOut, summary="파생 지표만 조회")
async def get_metrics(
    product_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> ProductMetricsOut:
    """제품의 파생 지표.

    구매 건이 없으면 지표 쿼리가 행을 만들지 않는다. 이때 404 를 반환하면 "구매 기록이 아직
    없다" 는 정상 상태를 오류로 알리는 셈이다. 병수 0, 금액 null 로 응답한다. 제품 자체가
    없는 경우는 `load_product` 가 404 로 처리한다.
    """
    await load_product(session, user_id=user_id, product_id=product_id)
    row = (await session.execute(single_product_metrics_query(user_id, product_id))).first()
    return ProductMetricsOut(**metrics_from_row(row))
