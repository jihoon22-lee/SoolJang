"""카테고리 계층 조작.

사용자가 계층을 자유롭게 바꿀 수 있으므로(`docs/architecture.md` §2.3) DB 제약으로 표현할 수
없는 불변식을 여기서 강제한다.

- **순환 금지**: 어떤 카테고리도 자기 자신의 조상이 될 수 없다
- **깊이 상한**: `MAX_CATEGORY_DEPTH`. 폭주하는 중첩을 막는 안전장치
- **이동 시 후손 동반**: `parent_id` 만 바꾸면 서브트리가 함께 따라온다

계층 조회는 재귀 CTE 로 처리한다. `depth` 를 저장하지 않는 이유는 이동이 자유로워 값이
어긋나면 조회가 조용히 틀리기 때문이다(§5-D26).
"""

import datetime
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, Text, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import Category, CategorySeed, Product
from sooljang.infrastructure.legacy.categories import (
    MAX_CATEGORY_DEPTH,
    default_seed_paths,
)

_SLUG_STRIP = re.compile(r"[^0-9a-z가-힣]+")


class CategoryError(ValueError):
    """카테고리 조작이 불변식을 위반했을 때 발생한다."""


class CategoryCycleError(CategoryError):
    """자기 자신의 후손을 부모로 지정했을 때 발생한다."""


class CategoryDepthError(CategoryError):
    """깊이 상한을 넘었을 때 발생한다."""


class CategoryNotEmptyError(CategoryError):
    """하위 카테고리나 소속 제품이 있는 카테고리를 그냥 삭제하려 했을 때 발생한다."""


def make_slug(name: str) -> str:
    """이름에서 검색·URL 용 slug 를 만든다."""
    lowered = name.strip().lower()
    return _SLUG_STRIP.sub("-", lowered).strip("-") or "category"


@dataclass(frozen=True, slots=True)
class CategoryNode:
    """계층 조회 결과 한 건. 깊이와 경로를 함께 담는다."""

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    depth: int
    path: tuple[str, ...]

    @property
    def is_root(self) -> bool:
        return self.parent_id is None


def descendant_ids_query(root_id: uuid.UUID) -> Select[tuple[uuid.UUID]]:
    """주어진 카테고리와 그 모든 후손의 id 를 구하는 재귀 CTE.

    "위스키" 필터가 하위 전부를 포함해야 하므로 조회마다 이 판정이 필요하다.
    """
    base = (
        select(Category.id.label("id"))
        .where(Category.id == root_id, Category.deleted_at.is_(None))
        .cte("category_tree", recursive=True)
    )
    child = select(Category.id).where(
        Category.parent_id == base.c.id, Category.deleted_at.is_(None)
    )
    tree = base.union_all(child)
    return select(tree.c.id)


def ancestor_ids_query(node_id: uuid.UUID) -> Select[tuple[uuid.UUID]]:
    """주어진 카테고리와 그 모든 조상의 id 를 구하는 재귀 CTE."""
    base = (
        select(Category.id.label("id"), Category.parent_id.label("parent_id"))
        .where(Category.id == node_id, Category.deleted_at.is_(None))
        .cte("category_ancestors", recursive=True)
    )
    parent = select(Category.id, Category.parent_id).where(
        Category.id == base.c.parent_id, Category.deleted_at.is_(None)
    )
    tree = base.union_all(parent)
    return select(tree.c.id)


def tree_query(user_id: uuid.UUID) -> Select[tuple[uuid.UUID, uuid.UUID | None, str, int, str]]:
    """사용자의 전체 계층을 깊이·경로와 함께 조회한다.

    경로는 `\\x1f`(unit separator) 로 이어 붙인다. 카테고리 이름에 나타날 수 없는 문자를
    구분자로 써야 `와인 > 레드와인` 같은 이름을 쪼갤 때 오작동하지 않는다.
    """
    separator = "\x1f"
    base = (
        select(
            Category.id.label("id"),
            Category.parent_id.label("parent_id"),
            Category.name.label("name"),
            literal(1).label("depth"),
            # PostgreSQL 은 재귀 CTE 의 비재귀 항과 재귀 항의 타입이 같아야 한다.
            # Category.name 은 varchar(120) 이고 재귀 항의 연결 결과는 text 이므로
            # 비재귀 항을 명시적으로 text 로 캐스팅한다.
            cast(Category.name, Text).label("path"),
            Category.sort_order.label("sort_order"),
        )
        .where(
            Category.user_id == user_id,
            Category.parent_id.is_(None),
            Category.deleted_at.is_(None),
        )
        .cte("category_full_tree", recursive=True)
    )
    child = select(
        Category.id,
        Category.parent_id,
        Category.name,
        (base.c.depth + 1).label("depth"),
        cast(base.c.path + separator + Category.name, Text).label("path"),
        Category.sort_order,
    ).where(Category.parent_id == base.c.id, Category.deleted_at.is_(None))
    tree = base.union_all(child)
    return select(tree.c.id, tree.c.parent_id, tree.c.name, tree.c.depth, tree.c.path).order_by(
        tree.c.path
    )


def parse_path(path: str) -> tuple[str, ...]:
    """`tree_query` 가 만든 경로 문자열을 튜플로 되돌린다."""
    return tuple(path.split("\x1f"))


async def load_tree(session: AsyncSession, user_id: uuid.UUID) -> list[CategoryNode]:
    """사용자의 전체 계층을 노드 목록으로 읽는다."""
    result = await session.execute(tree_query(user_id))
    return [
        CategoryNode(
            id=row.id,
            parent_id=row.parent_id,
            name=row.name,
            depth=row.depth,
            path=parse_path(row.path),
        )
        for row in result
    ]


async def _depth_of(session: AsyncSession, category_id: uuid.UUID) -> int:
    """조상 수를 세어 깊이를 구한다. 자기 자신을 포함해 1부터 시작한다."""
    result = await session.execute(ancestor_ids_query(category_id))
    return len(result.scalars().all())


async def _subtree_height(session: AsyncSession, category_id: uuid.UUID) -> int:
    """서브트리의 높이. 자기 자신만 있으면 1이다."""
    tree = await session.execute(descendant_ids_query(category_id))
    ids = set(tree.scalars().all())
    if not ids:
        return 1
    rows = await session.execute(
        select(Category.id, Category.parent_id).where(Category.id.in_(ids))
    )
    parents: dict[uuid.UUID, uuid.UUID | None] = {row.id: row.parent_id for row in rows}

    def height(node: uuid.UUID) -> int:
        children = [child for child, parent in parents.items() if parent == node]
        return 1 + max((height(child) for child in children), default=0)

    return height(category_id)


async def create_category(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    name: str,
    parent_id: uuid.UUID | None = None,
    sort_order: int = 0,
    is_seeded: bool = False,
    id: uuid.UUID | None = None,  # noqa: A002 - 오프라인 outbox 가 미리 생성한 PK
) -> Category:
    """카테고리를 만든다. 깊이 상한을 검사한다.

    `id` 를 지정하면 그대로 쓴다 — 오프라인에서 클라이언트가 미리 만든 UUIDv7 PK 를
    그대로 반영해야 재동기화 시 같은 레코드로 인식된다(`docs/architecture.md` §5.2).
    """
    if parent_id is not None:
        parent_depth = await _depth_of(session, parent_id)
        if parent_depth + 1 > MAX_CATEGORY_DEPTH:
            raise CategoryDepthError(
                f"계층 깊이가 상한({MAX_CATEGORY_DEPTH})을 넘습니다: {parent_depth + 1}"
            )

    kwargs: dict[str, Any] = {
        "user_id": user_id,
        "parent_id": parent_id,
        "name": name.strip(),
        "slug": make_slug(name),
        "sort_order": sort_order,
        "is_seeded": is_seeded,
    }
    if id is not None:
        kwargs["id"] = id
    category = Category(**kwargs)
    session.add(category)
    await session.flush()
    return category


async def reparent_category(
    session: AsyncSession, *, category_id: uuid.UUID, new_parent_id: uuid.UUID | None
) -> Category:
    """부모를 바꾼다. 서브트리 전체가 함께 이동한다.

    자기 자신이나 후손을 부모로 지정하면 순환이 생겨 재귀 CTE 가 무한히 돈다. 반드시
    먼저 막는다.
    """
    category = await session.get(Category, category_id)
    if category is None:
        raise CategoryError(f"카테고리를 찾을 수 없습니다: {category_id}")

    if new_parent_id is not None:
        if new_parent_id == category_id:
            raise CategoryCycleError("자기 자신을 부모로 지정할 수 없습니다")
        descendants = await session.execute(descendant_ids_query(category_id))
        if new_parent_id in set(descendants.scalars().all()):
            raise CategoryCycleError("후손을 부모로 지정할 수 없습니다 (순환)")

        parent_depth = await _depth_of(session, new_parent_id)
        height = await _subtree_height(session, category_id)
        if parent_depth + height > MAX_CATEGORY_DEPTH:
            raise CategoryDepthError(
                f"이동하면 계층 깊이가 상한({MAX_CATEGORY_DEPTH})을 넘습니다: "
                f"{parent_depth + height}"
            )

    category.parent_id = new_parent_id
    await session.flush()
    return category


async def get_category_seed(session: AsyncSession, *, user_id: uuid.UUID) -> CategorySeed | None:
    """사용자가 저장해 둔 기본 주종 구조. 없으면 `None`(하드코딩된 기본값을 쓴다)."""
    return await session.scalar(
        select(CategorySeed)
        .where(CategorySeed.user_id == user_id, CategorySeed.deleted_at.is_(None))
        .order_by(CategorySeed.created_at.desc())
        .limit(1)
    )


async def save_category_seed(
    session: AsyncSession, *, user_id: uuid.UUID, paths: list[list[str]]
) -> CategorySeed:
    """기본 주종 구조를 저장한다. 기존 저장이 있으면 갱신하고, 없으면 새로 만든다."""
    existing = await get_category_seed(session, user_id=user_id)
    if existing is not None:
        existing.paths = paths
        await session.flush()
        return existing

    created = CategorySeed(user_id=user_id, paths=paths)
    session.add(created)
    await session.flush()
    return created


async def save_current_tree_as_seed(session: AsyncSession, *, user_id: uuid.UUID) -> CategorySeed:
    """지금 화면의 주종 구조를, 앞으로 "기본 주종 복원"이 되돌릴 기준으로 저장한다.

    부모가 자식보다 먼저 오도록 깊이 오름차순으로 정렬해 둔다 — `seed_default_categories`
    가 이 순서 그대로 upsert 하므로, 자식을 만들 때 부모가 이미 있어야 한다.
    """
    tree = await load_tree(session, user_id)
    paths = sorted({node.path for node in tree}, key=lambda path: (len(path), path))
    return await save_category_seed(session, user_id=user_id, paths=[list(path) for path in paths])


async def _resolve_seed_paths(
    session: AsyncSession, *, user_id: uuid.UUID
) -> list[tuple[str, ...]]:
    """이 사용자에게 적용할 시드 경로. 저장된 구조가 있으면 그것을, 없으면 하드코딩된
    전역 기본값을 쓴다."""
    saved = await get_category_seed(session, user_id=user_id)
    if saved is not None:
        return [tuple(path) for path in saved.paths]
    return default_seed_paths()


async def seed_default_categories(session: AsyncSession, *, user_id: uuid.UUID) -> list[Category]:
    """기본 계층을 upsert 한다.

    이미 있는 경로는 건드리지 않는다. 사용자가 이름을 바꾸거나 삭제한 항목을 시드가
    되살리면 사용자의 편집을 무시하는 셈이 된다(§5-D27). "기본"이 무엇인지는
    `_resolve_seed_paths` 가 정한다 — 사용자가 `save_current_tree_as_seed` 로 자기
    구조를 저장해 뒀으면 하드코딩된 전역 기본값 대신 그 구조로 복원한다(Task 28).
    """
    created: list[Category] = []
    by_path: dict[tuple[str, ...], uuid.UUID] = {}

    existing = await load_tree(session, user_id)
    for node in existing:
        by_path[node.path] = node.id

    seed_paths = await _resolve_seed_paths(session, user_id=user_id)
    for order, path in enumerate(seed_paths):
        if path in by_path:
            continue
        parent_id = by_path.get(path[:-1]) if len(path) > 1 else None
        if len(path) > 1 and parent_id is None:
            # 부모가 사용자에 의해 삭제·이동된 경우다. 자식을 억지로 만들지 않는다.
            continue
        category = await create_category(
            session,
            user_id=user_id,
            name=path[-1],
            parent_id=parent_id,
            sort_order=order,
            is_seeded=True,
        )
        by_path[path] = category.id
        created.append(category)

    return created


async def direct_product_counts(session: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """카테고리별로 직접 속한 제품 수."""
    rows = await session.execute(
        select(Product.category_id, func.count())
        .where(
            Product.user_id == user_id,
            Product.deleted_at.is_(None),
            Product.category_id.is_not(None),
        )
        .group_by(Product.category_id)
    )
    return {row[0]: row[1] for row in rows if row[0] is not None}


def rollup_product_counts(
    nodes: Sequence[CategoryNode], direct: dict[uuid.UUID, int]
) -> dict[uuid.UUID, int]:
    """후손을 포함한 제품 수. 필터가 하위를 포함하므로 목록 배지에도 이 값이 맞다.

    깊은 쪽부터 부모로 더해 올린다. 깊이 역순으로 돌면 자식이 항상 부모보다 먼저 온다.
    """
    totals = {node.id: direct.get(node.id, 0) for node in nodes}
    for node in sorted(nodes, key=lambda item: item.depth, reverse=True):
        if node.parent_id is not None and node.parent_id in totals:
            totals[node.parent_id] += totals[node.id]
    return totals


async def reorder_categories(
    session: AsyncSession, *, user_id: uuid.UUID, order_by_id: dict[uuid.UUID, int]
) -> int:
    """형제 간 표시 순서를 일괄 변경한다. 갱신된 건수를 반환한다."""
    if not order_by_id:
        return 0
    rows = await session.scalars(
        select(Category).where(
            Category.user_id == user_id,
            Category.id.in_(list(order_by_id)),
            Category.deleted_at.is_(None),
        )
    )
    updated = 0
    for category in rows:
        category.sort_order = order_by_id[category.id]
        updated += 1
    if updated != len(order_by_id):
        raise CategoryError("일부 카테고리를 찾을 수 없습니다")
    await session.flush()
    return updated


async def _child_ids(session: AsyncSession, category_id: uuid.UUID) -> list[uuid.UUID]:
    rows = await session.scalars(
        select(Category.id).where(Category.parent_id == category_id, Category.deleted_at.is_(None))
    )
    return list(rows)


async def _products_in(session: AsyncSession, category_id: uuid.UUID) -> list[Product]:
    rows = await session.scalars(
        select(Product).where(Product.category_id == category_id, Product.deleted_at.is_(None))
    )
    return list(rows)


async def _load_owned(
    session: AsyncSession, user_id: uuid.UUID, category_id: uuid.UUID, label: str
) -> Category:
    category = await session.get(Category, category_id)
    if category is None or category.deleted_at is not None or category.user_id != user_id:
        raise CategoryError(f"{label} 카테고리를 찾을 수 없습니다: {category_id}")
    return category


async def delete_category(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    category_id: uuid.UUID,
    promote_children: bool = False,
    reassign_to: uuid.UUID | None = None,
) -> Category:
    """카테고리를 soft delete 한다.

    **제품은 지우지 않는다.** 개인 기록을 잃는 것이 가장 큰 손실이다. 하위나 소속 제품이
    있으면 기본은 거부하고, 사용자가 처리 방식을 명시해야 삭제된다
    (`docs/architecture.md` §2.3 삭제 정책).
    """
    category = await _load_owned(session, user_id, category_id, "대상")

    children = await _child_ids(session, category_id)
    if children:
        if not promote_children:
            raise CategoryNotEmptyError(
                f"하위 카테고리 {len(children)}개가 있습니다. "
                "promote_children 을 지정하면 상위로 올린 뒤 삭제합니다"
            )
        for child_id in children:
            child = await session.get(Category, child_id)
            if child is not None:
                child.parent_id = category.parent_id

    products = await _products_in(session, category_id)
    if products:
        if reassign_to is None:
            raise CategoryNotEmptyError(
                f"소속 제품 {len(products)}개가 있습니다. reassign_to 로 옮길 카테고리를 지정하세요"
            )
        await _load_owned(session, user_id, reassign_to, "옮길")
        for product in products:
            product.category_id = reassign_to

    category.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()
    return category


async def merge_categories(
    session: AsyncSession, *, user_id: uuid.UUID, source_id: uuid.UUID, target_id: uuid.UUID
) -> int:
    """원본의 제품과 하위를 대상으로 옮기고 원본을 soft delete 한다.

    중복 생성된 카테고리를 정리하는 경로다. 옮긴 제품 수를 반환한다.
    """
    if source_id == target_id:
        raise CategoryError("자기 자신과 병합할 수 없습니다")

    source = await _load_owned(session, user_id, source_id, "원본")
    await _load_owned(session, user_id, target_id, "대상")

    # 대상이 원본의 후손이면 병합 후 순환이 생긴다.
    descendants = await session.execute(descendant_ids_query(source_id))
    if target_id in set(descendants.scalars().all()):
        raise CategoryCycleError("후손 카테고리로 병합할 수 없습니다 (순환)")

    for child_id in await _child_ids(session, source_id):
        child = await session.get(Category, child_id)
        if child is not None:
            child.parent_id = target_id

    products = await _products_in(session, source_id)
    for product in products:
        product.category_id = target_id

    source.deleted_at = datetime.datetime.now(datetime.UTC)
    await session.flush()
    return len(products)
