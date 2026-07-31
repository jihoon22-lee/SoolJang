"""카테고리 계층 테스트.

주종 계층은 사용자가 자유롭게 관리하는 데이터다. 깊이 제한이 없고 이동이 자유로우므로
순환과 폭주를 막는 불변식이 실제로 동작하는지가 핵심이다.
"""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.categories import (
    CategoryCycleError,
    CategoryDepthError,
    create_category,
    descendant_ids_query,
    load_tree,
    make_slug,
    reparent_category,
    seed_default_categories,
)
from sooljang.infrastructure.database.models import Category
from sooljang.infrastructure.legacy.categories import MAX_CATEGORY_DEPTH

pytestmark = pytest.mark.requires_db


async def _chain(session: AsyncSession, user_id: uuid.UUID, *names: str) -> list[Category]:
    """이름을 순서대로 부모-자식으로 이어 만든다."""
    created: list[Category] = []
    parent_id: uuid.UUID | None = None
    for name in names:
        category = await create_category(session, user_id=user_id, name=name, parent_id=parent_id)
        created.append(category)
        parent_id = category.id
    return created


def test_slug_is_generated_from_korean_name() -> None:
    assert make_slug("싱글몰트 위스키") == "싱글몰트-위스키"
    assert make_slug("Cabernet Sauvignon!") == "cabernet-sauvignon"
    assert make_slug("///") == "category"


async def test_arbitrary_depth_is_allowed(session: AsyncSession, user_id: uuid.UUID) -> None:
    """사용자가 필요한 만큼 세분화할 수 있어야 한다."""
    names = [f"레벨{index}" for index in range(1, MAX_CATEGORY_DEPTH + 1)]
    await _chain(session, user_id, *names)

    nodes = await load_tree(session, user_id)

    assert max(node.depth for node in nodes) == MAX_CATEGORY_DEPTH
    deepest = next(node for node in nodes if node.depth == MAX_CATEGORY_DEPTH)
    assert deepest.path == tuple(names)


async def test_depth_guard_rejects_going_beyond_the_cap(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    chain = await _chain(session, user_id, *[f"레벨{i}" for i in range(1, MAX_CATEGORY_DEPTH + 1)])

    with pytest.raises(CategoryDepthError, match="상한"):
        await create_category(session, user_id=user_id, name="한 단계 더", parent_id=chain[-1].id)


async def test_reparent_moves_the_whole_subtree(session: AsyncSession, user_id: uuid.UUID) -> None:
    wine, sweet, tokaji = await _chain(session, user_id, "와인", "스위트와인", "토카이와인")
    other = await create_category(session, user_id=user_id, name="기타")

    await reparent_category(session, category_id=sweet.id, new_parent_id=other.id)

    nodes = {node.name: node for node in await load_tree(session, user_id)}

    assert nodes["스위트와인"].path == ("기타", "스위트와인")
    # 후손이 함께 따라와야 한다.
    assert nodes["토카이와인"].path == ("기타", "스위트와인", "토카이와인")
    assert nodes["와인"].path == ("와인",)
    assert tokaji.id != wine.id


async def test_reparent_to_self_is_rejected(session: AsyncSession, user_id: uuid.UUID) -> None:
    category = await create_category(session, user_id=user_id, name="와인")

    with pytest.raises(CategoryCycleError, match="자기 자신"):
        await reparent_category(session, category_id=category.id, new_parent_id=category.id)


async def test_reparent_to_descendant_is_rejected(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """후손을 부모로 지정하면 순환이 생겨 재귀 CTE 가 무한히 돈다."""
    wine, sweet, tokaji = await _chain(session, user_id, "와인", "스위트와인", "토카이와인")

    with pytest.raises(CategoryCycleError, match="순환"):
        await reparent_category(session, category_id=wine.id, new_parent_id=tokaji.id)

    assert sweet.parent_id == wine.id


async def test_reparent_to_root_is_allowed(session: AsyncSession, user_id: uuid.UUID) -> None:
    _, sweet = await _chain(session, user_id, "와인", "스위트와인")

    await reparent_category(session, category_id=sweet.id, new_parent_id=None)

    nodes = {node.name: node for node in await load_tree(session, user_id)}
    assert nodes["스위트와인"].is_root


async def test_reparent_rejects_move_that_would_exceed_depth(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    # 높이 3인 서브트리를 깊이 (상한-1) 지점으로 옮기면 상한을 넘는다.
    deep = await _chain(session, user_id, *[f"깊이{i}" for i in range(1, MAX_CATEGORY_DEPTH)])
    subtree = await _chain(session, user_id, "루트", "중간", "말단")

    with pytest.raises(CategoryDepthError, match="상한"):
        await reparent_category(session, category_id=subtree[0].id, new_parent_id=deep[-1].id)


async def test_descendant_query_includes_self_and_all_descendants(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    whisky, single_malt = await _chain(session, user_id, "위스키", "싱글몰트")
    bourbon = await create_category(session, user_id=user_id, name="버번", parent_id=whisky.id)

    result = await session.execute(descendant_ids_query(whisky.id))
    ids = set(result.scalars().all())

    assert ids == {whisky.id, single_malt.id, bourbon.id}


async def test_soft_deleted_categories_are_excluded_from_the_tree(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    import datetime

    _, sweet = await _chain(session, user_id, "와인", "스위트와인")
    sweet.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()

    names = {node.name for node in await load_tree(session, user_id)}

    assert names == {"와인"}


async def test_tree_is_scoped_per_user(
    session: AsyncSession, user_id: uuid.UUID, other_user_id: uuid.UUID
) -> None:
    await create_category(session, user_id=user_id, name="내 카테고리")
    await create_category(session, user_id=other_user_id, name="남의 카테고리")

    mine = {node.name for node in await load_tree(session, user_id)}
    theirs = {node.name for node in await load_tree(session, other_user_id)}

    assert mine == {"내 카테고리"}
    assert theirs == {"남의 카테고리"}


async def test_same_name_allowed_under_different_parents(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """전통주 리큐르와 기타 양주 리큐르는 다른 카테고리다."""
    traditional = await create_category(session, user_id=user_id, name="전통주")
    spirits = await create_category(session, user_id=user_id, name="기타 양주")

    await create_category(session, user_id=user_id, name="리큐르", parent_id=traditional.id)
    await create_category(session, user_id=user_id, name="리큐르", parent_id=spirits.id)

    paths = {node.path for node in await load_tree(session, user_id)}

    assert ("전통주", "리큐르") in paths
    assert ("기타 양주", "리큐르") in paths


# --- 기본 시드 --------------------------------------------------------------


async def test_seed_creates_default_hierarchy(session: AsyncSession, user_id: uuid.UUID) -> None:
    created = await seed_default_categories(session, user_id=user_id)

    assert created
    paths = {node.path for node in await load_tree(session, user_id)}

    # 레거시 롤업에서 도출한 최상위 5개 + 미분류
    assert ("맥주",) in paths
    assert ("와인", "스위트와인", "토카이와인") in paths
    assert ("양주", "위스키", "싱글몰트 위스키") in paths
    assert ("전통주", "탁주") in paths
    assert ("사케",) in paths
    assert ("미분류",) in paths


async def test_seed_is_idempotent(session: AsyncSession, user_id: uuid.UUID) -> None:
    first = await seed_default_categories(session, user_id=user_id)
    second = await seed_default_categories(session, user_id=user_id)

    assert first
    assert second == []


async def test_seed_does_not_resurrect_user_edits(
    session: AsyncSession, user_id: uuid.UUID
) -> None:
    """사용자가 이름을 바꾼 항목을 시드가 되살리면 편집을 무시하는 셈이다."""
    await seed_default_categories(session, user_id=user_id)

    sake = await session.scalar(
        select(Category).where(Category.user_id == user_id, Category.name == "사케")
    )
    assert sake is not None
    sake.name = "니혼슈"
    await session.flush()

    created_again = await seed_default_categories(session, user_id=user_id)

    names = {node.name for node in await load_tree(session, user_id)}
    assert "니혼슈" in names
    # 시드가 "사케" 를 다시 만들 수는 있지만, 이름을 바꾼 항목을 덮어쓰지는 않는다.
    assert sake.name == "니혼슈"
    assert all(category.name != "니혼슈" for category in created_again)


async def test_seeded_flag_marks_default_entries(session: AsyncSession, user_id: uuid.UUID) -> None:
    await seed_default_categories(session, user_id=user_id)
    custom = await create_category(session, user_id=user_id, name="내가 만든 주종")

    seeded = await session.scalars(
        select(Category).where(Category.user_id == user_id, Category.is_seeded.is_(True))
    )

    assert len(list(seeded)) > 0
    assert custom.is_seeded is False
