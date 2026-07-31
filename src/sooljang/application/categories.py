"""카테고리 계층 조작.

사용자가 계층을 자유롭게 바꿀 수 있으므로(`docs/architecture.md` §2.3) DB 제약으로 표현할 수
없는 불변식을 여기서 강제한다.

- **순환 금지**: 어떤 카테고리도 자기 자신의 조상이 될 수 없다
- **깊이 상한**: `MAX_CATEGORY_DEPTH`. 폭주하는 중첩을 막는 안전장치
- **이동 시 후손 동반**: `parent_id` 만 바꾸면 서브트리가 함께 따라온다

계층 조회는 재귀 CTE 로 처리한다. `depth` 를 저장하지 않는 이유는 이동이 자유로워 값이
어긋나면 조회가 조용히 틀리기 때문이다(§5-D26).
"""

import re
import uuid
from dataclasses import dataclass

from sqlalchemy import Select, Text, cast, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import Category
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
) -> Category:
    """카테고리를 만든다. 깊이 상한을 검사한다."""
    if parent_id is not None:
        parent_depth = await _depth_of(session, parent_id)
        if parent_depth + 1 > MAX_CATEGORY_DEPTH:
            raise CategoryDepthError(
                f"계층 깊이가 상한({MAX_CATEGORY_DEPTH})을 넘습니다: {parent_depth + 1}"
            )

    category = Category(
        user_id=user_id,
        parent_id=parent_id,
        name=name.strip(),
        slug=make_slug(name),
        sort_order=sort_order,
        is_seeded=is_seeded,
    )
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


async def seed_default_categories(session: AsyncSession, *, user_id: uuid.UUID) -> list[Category]:
    """기본 계층을 upsert 한다.

    이미 있는 경로는 건드리지 않는다. 사용자가 이름을 바꾸거나 삭제한 항목을 시드가
    되살리면 사용자의 편집을 무시하는 셈이 된다(§5-D27).
    """
    created: list[Category] = []
    by_path: dict[tuple[str, ...], uuid.UUID] = {}

    existing = await load_tree(session, user_id)
    for node in existing:
        by_path[node.path] = node.id

    for order, path in enumerate(default_seed_paths()):
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
