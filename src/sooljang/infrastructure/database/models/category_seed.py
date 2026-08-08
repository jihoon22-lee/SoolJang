"""사용자가 저장한 "기본 주종 구조"(Task 28).

"기본 주종 복원"(`categories:reset-seed`)은 지금까지 항상 하드코딩된 전역 기본값
(`infrastructure/legacy/categories.py::default_seed_paths`)으로만 되돌렸다. 사용자가
스스로 정리한 구조를 앞으로의 "기본"으로 삼고 싶다는 요청(Task 28)에 따라, 그 시점의
전체 경로 목록을 사용자당 하나만 저장해 둔다 — 이후 시드 복원은 이 값이 있으면 이 값을,
없으면 기존 하드코딩된 기본값을 쓴다(`application/categories.py::_resolve_seed_paths`).

`paths` 는 `[["와인"], ["와인","레드와인"], ...]` 형태의 JSON 을 그대로 저장한다.
`SavedView.definition` 과 같은 판단이다 — 경로 목록 자체가 이미 작은 구조라 별도
테이블로 정규화할 이득이 없다.

**사용자당 활성 행이 최대 1개다.** DB 유니크 제약을 두지 않는 이유는 `LlmSetting` 과
같다 — 여기서는 애초에 soft delete 후 재저장 흐름을 쓰지 않고 기존 행을 그대로
갱신하므로(`application/categories.py::save_category_seed`) 실제로는 항상 최대
1개만 남는다. 그래도 여러 행이 남는 경쟁 상황을 대비해 `LlmSetting`/`SavedView` 와
같은 조회 규약(가장 최근 것)을 따른다.

**동기화 대상이 아니다.** 시드 복원 자체가 온라인 전용 연산이라(순환·깊이 재검사 필요),
이 값이 클라이언트에 미러링돼 봐야 쓸 곳이 없다(`LlmSetting`/`SavedView` 와 같은 이유).
"""

from typing import Any

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class CategorySeed(Base, EntityMixin):
    """사용자가 저장한 기본 주종 구조 스냅샷."""

    __tablename__ = "category_seed"

    #: 경로 목록. 각 경로는 최상위부터의 이름 리스트(예: `["와인", "레드와인"]`).
    paths: Mapped[list[list[str]]] = mapped_column(JSONB, nullable=False)

    def __repr__(self) -> str:
        return f"<CategorySeed user={self.user_id} paths={len(self.paths)}>"
