"""카테고리(주종) 라우터.

주종 계층은 사용자가 자유롭게 관리하는 데이터다. 단순 CRUD 외에 이동·순서 변경·병합·시드
복원을 별도 동작으로 제공한다. 부모 변경을 `PATCH` 에 섞지 않고 `:reparent` 로 분리한 이유는
순환 검사와 깊이 검사가 필요한 별개의 연산이기 때문이다.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import select

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.api.schemas.category import (
    CategoryCreate,
    CategoryMerge,
    CategoryNodeOut,
    CategoryReorder,
    CategoryReparent,
    CategoryTreeOut,
    CategoryUpdate,
    DeleteStrategy,
)
from sooljang.application.categories import (
    CategoryCycleError,
    CategoryDepthError,
    CategoryError,
    CategoryNotEmptyError,
    create_category,
    delete_category,
    direct_product_counts,
    load_tree,
    make_slug,
    merge_categories,
    reorder_categories,
    reparent_category,
    rollup_product_counts,
    save_current_tree_as_seed,
    seed_default_categories,
)
from sooljang.infrastructure.database.models import Category
from sooljang.infrastructure.legacy.categories import MAX_CATEGORY_DEPTH

router = APIRouter(prefix="/categories", tags=["categories"])


async def _tree_response(session: SessionDep, user_id: uuid.UUID) -> CategoryTreeOut:
    nodes = await load_tree(session, user_id)
    direct = await direct_product_counts(session, user_id)
    rollup = rollup_product_counts(nodes, direct)

    seeded_flags = {
        row[0]: row[1]
        for row in await session.execute(
            select(Category.id, Category.is_seeded).where(
                Category.user_id == user_id, Category.deleted_at.is_(None)
            )
        )
    }
    sort_orders = {
        row[0]: row[1]
        for row in await session.execute(
            select(Category.id, Category.sort_order).where(
                Category.user_id == user_id, Category.deleted_at.is_(None)
            )
        )
    }

    items = [
        CategoryNodeOut(
            id=node.id,
            parent_id=node.parent_id,
            name=node.name,
            depth=node.depth,
            path=list(node.path),
            is_seeded=seeded_flags.get(node.id, False),
            sort_order=sort_orders.get(node.id, 0),
            product_count=direct.get(node.id, 0),
            descendant_product_count=rollup.get(node.id, 0),
        )
        for node in nodes
    ]
    return CategoryTreeOut(
        items=items,
        max_depth=max((node.depth for node in nodes), default=0),
        depth_limit=MAX_CATEGORY_DEPTH,
    )


def _translate(error: CategoryError) -> Exception:
    """서비스 예외를 API 에러로 옮긴다."""
    if isinstance(error, CategoryCycleError | CategoryDepthError):
        return ValidationFailedError(str(error))
    if isinstance(error, CategoryNotEmptyError):
        return ConflictError(str(error))
    return NotFoundError(str(error))


@router.get("", response_model=CategoryTreeOut, summary="주종 계층 전체 조회")
async def list_categories(session: SessionDep, user_id: UserDep) -> CategoryTreeOut:
    """계층 전체를 깊이·경로·제품 수와 함께 반환한다.

    수백 개 수준이라 페이지네이션하지 않는다. 트리는 부분만 받으면 그릴 수 없다.
    """
    return await _tree_response(session, user_id)


@router.post(
    "", response_model=CategoryNodeOut, status_code=status.HTTP_201_CREATED, summary="주종 추가"
)
async def create_category_endpoint(
    payload: CategoryCreate, session: SessionDep, user_id: UserDep
) -> CategoryNodeOut:
    try:
        category = await create_category(
            session,
            user_id=user_id,
            name=payload.name,
            parent_id=payload.parent_id,
            sort_order=payload.sort_order,
        )
    except CategoryError as error:
        raise _translate(error) from error

    if payload.note is not None:
        category.note = payload.note
        await session.flush()

    tree = await _tree_response(session, user_id)
    created = next((item for item in tree.items if item.id == category.id), None)
    if created is None:
        raise NotFoundError("생성한 카테고리를 다시 읽지 못했습니다")
    return created


@router.patch("/{category_id}", response_model=CategoryNodeOut, summary="주종 수정")
async def update_category(
    category_id: uuid.UUID, payload: CategoryUpdate, session: SessionDep, user_id: UserDep
) -> CategoryNodeOut:
    category = await session.get(Category, category_id)
    if category is None or category.deleted_at is not None or category.user_id != user_id:
        raise NotFoundError(f"카테고리를 찾을 수 없습니다: {category_id}")

    if payload.name is not None:
        category.name = payload.name.strip()
        # slug 는 이름에서 파생된다. 이름을 바꾸면 함께 갱신한다.
        category.slug = make_slug(payload.name)
    if payload.sort_order is not None:
        category.sort_order = payload.sort_order
    if payload.note is not None:
        category.note = payload.note
    await session.flush()

    tree = await _tree_response(session, user_id)
    updated = next((item for item in tree.items if item.id == category_id), None)
    if updated is None:
        raise NotFoundError("수정한 카테고리를 다시 읽지 못했습니다")
    return updated


@router.post("/{category_id}:reparent", response_model=CategoryTreeOut, summary="주종 이동")
async def reparent(
    category_id: uuid.UUID, payload: CategoryReparent, session: SessionDep, user_id: UserDep
) -> CategoryTreeOut:
    """부모를 바꾼다. 서브트리 전체가 함께 이동한다.

    자기 자신이나 후손을 부모로 지정하면 순환이 생겨 거부한다. 이동 후 깊이가 상한을 넘어도
    거부한다.
    """
    category = await session.get(Category, category_id)
    if category is None or category.deleted_at is not None or category.user_id != user_id:
        raise NotFoundError(f"카테고리를 찾을 수 없습니다: {category_id}")

    try:
        await reparent_category(
            session, category_id=category_id, new_parent_id=payload.new_parent_id
        )
    except CategoryError as error:
        raise _translate(error) from error
    return await _tree_response(session, user_id)


@router.post(":reorder", response_model=CategoryTreeOut, summary="표시 순서 일괄 변경")
async def reorder(
    payload: CategoryReorder, session: SessionDep, user_id: UserDep
) -> CategoryTreeOut:
    order_by_id = {item.id: item.sort_order for item in payload.items}
    if len(order_by_id) != len(payload.items):
        raise ValidationFailedError("중복된 카테고리 id 가 있습니다")
    try:
        await reorder_categories(session, user_id=user_id, order_by_id=order_by_id)
    except CategoryError as error:
        raise _translate(error) from error
    return await _tree_response(session, user_id)


@router.post("/{category_id}:merge", response_model=CategoryTreeOut, summary="주종 병합")
async def merge(
    category_id: uuid.UUID, payload: CategoryMerge, session: SessionDep, user_id: UserDep
) -> CategoryTreeOut:
    """원본의 제품과 하위를 대상으로 옮기고 원본을 삭제한다."""
    try:
        await merge_categories(
            session, user_id=user_id, source_id=category_id, target_id=payload.target_id
        )
    except CategoryError as error:
        raise _translate(error) from error
    return await _tree_response(session, user_id)


@router.post(":reset-seed", response_model=CategoryTreeOut, summary="기본 주종 복원")
async def reset_seed(session: SessionDep, user_id: UserDep) -> CategoryTreeOut:
    """기본 계층을 복원한다.

    upsert 이므로 사용자가 만든 항목과 이름을 바꾼 항목은 그대로 유지된다. 사용자가
    `:save-as-default` 로 저장해 둔 구조가 있으면 그걸, 없으면 앱 기본값을 기준으로
    복원한다.
    """
    await seed_default_categories(session, user_id=user_id)
    return await _tree_response(session, user_id)


@router.post(":save-as-default", response_model=CategoryTreeOut, summary="현재 구조를 기본으로 저장")
async def save_as_default(session: SessionDep, user_id: UserDep) -> CategoryTreeOut:
    """지금 화면의 주종 구조를, 앞으로 `:reset-seed` 가 되돌릴 기준으로 저장한다.

    현재 계층 자체는 바뀌지 않는다 — 저장된 기준만 갱신된다.
    """
    await save_current_tree_as_seed(session, user_id=user_id)
    return await _tree_response(session, user_id)


@router.delete("/{category_id}", response_model=CategoryTreeOut, summary="주종 삭제")
async def delete(
    category_id: uuid.UUID,
    session: SessionDep,
    user_id: UserDep,
    strategy: Annotated[
        DeleteStrategy, Query(description="하위·소속 제품 처리 방식. 기본은 거부")
    ] = DeleteStrategy.REJECT,
    target_id: Annotated[
        uuid.UUID | None, Query(description="strategy=reassign 일 때 제품을 옮길 카테고리")
    ] = None,
) -> CategoryTreeOut:
    """카테고리를 삭제한다. **제품은 지우지 않는다.**

    하위 카테고리나 소속 제품이 있으면 기본은 거부한다. 개인 기록을 잃는 것이 가장 큰
    손실이므로 사용자가 처리 방식을 명시해야 삭제된다.
    """
    if strategy is DeleteStrategy.REASSIGN and target_id is None:
        raise ValidationFailedError("strategy=reassign 이면 target_id 가 필요합니다")

    try:
        await delete_category(
            session,
            user_id=user_id,
            category_id=category_id,
            promote_children=strategy is DeleteStrategy.PROMOTE_CHILDREN,
            reassign_to=target_id,
        )
    except CategoryError as error:
        raise _translate(error) from error
    return await _tree_response(session, user_id)
