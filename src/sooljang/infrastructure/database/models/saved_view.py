"""커스텀 피벗 저장(Task 20).

사용자가 만든 피벗 정의(그룹 축·집계 지표·필터)를 이름 붙여 저장해 다시 불러올 수 있게
한다. `definition` 은 `api/schemas/stats.py::PivotRequest` 와 같은 모양의 JSON 을
그대로 저장한다 — 별도 정규화 컬럼을 두지 않는 이유는, 피벗 정의 자체가 이미 몇 개
필드뿐인 작은 구조라 테이블 컬럼으로 쪼개는 이득이 없기 때문이다(`conflict_log` 의
`client_snapshot` 과 같은 판단).

**동기화 대상이 아니다.** 통계 v2 전체가 온라인 전용이다(Task 16·17 의 카메라·LLM 호출과
같은 이유 — 피벗 집계 자체가 서버 DB 조회를 전제한다). 저장된 뷰 정의만 오프라인에
미러링해 봐야 다시 실행할 방법이 없어 의미가 없다.
"""

from typing import Any

from sqlalchemy import String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from sooljang.infrastructure.database.base import Base, EntityMixin


class SavedView(Base, EntityMixin):
    """사용자가 저장한 피벗 뷰 하나."""

    __tablename__ = "saved_view"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    def __repr__(self) -> str:
        return f"<SavedView {self.name!r} user={self.user_id}>"
