"""카테고리 API 스키마.

주종 계층은 사용자가 자유롭게 관리하는 데이터다(`docs/architecture.md` §2.3). 깊이 제한이
없으므로 응답에 깊이와 경로를 함께 실어 클라이언트가 트리를 그릴 수 있게 한다.
"""

import uuid
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class CategoryCreate(BaseModel):
    """카테고리 생성 요청."""

    name: str = Field(min_length=1, max_length=120)
    parent_id: uuid.UUID | None = None
    sort_order: int = 0
    note: str | None = None


class CategoryUpdate(BaseModel):
    """카테고리 수정 요청. 부모 변경은 `:reparent` 로 분리했다."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    sort_order: int | None = None
    note: str | None = None


class CategoryNodeOut(BaseModel):
    """계층 조회 응답 한 건."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    depth: int = Field(description="1부터 시작하는 깊이")
    path: list[str] = Field(description="최상위부터 자신까지의 이름 경로")
    is_seeded: bool = False
    sort_order: int = 0
    product_count: int = Field(default=0, description="이 카테고리에 직접 속한 제품 수")
    descendant_product_count: int = Field(
        default=0, description="후손을 포함한 제품 수. 필터가 하위를 포함하기 때문에 필요하다"
    )


class CategoryReparent(BaseModel):
    """부모 변경 요청. 서브트리 전체가 함께 이동한다."""

    new_parent_id: uuid.UUID | None = Field(default=None, description="null 이면 최상위로 올린다")


class CategoryReorderItem(BaseModel):
    id: uuid.UUID
    sort_order: int


class CategoryReorder(BaseModel):
    """형제 간 표시 순서 일괄 변경."""

    items: list[CategoryReorderItem] = Field(min_length=1)


class CategoryMerge(BaseModel):
    """다른 카테고리로 병합. 제품과 하위를 옮기고 원본을 soft delete 한다."""

    target_id: uuid.UUID


class DeleteStrategy(StrEnum):
    """삭제 시 하위·소속 제품 처리 방식.

    기본은 거부다. 개인 기록을 잃는 것이 가장 큰 손실이므로 사용자가 명시적으로 선택해야
    삭제된다(`docs/architecture.md` §2.3).
    """

    REJECT = "reject"
    PROMOTE_CHILDREN = "promote_children"
    REASSIGN = "reassign"


class CategoryTreeOut(BaseModel):
    """계층 전체 응답."""

    items: list[CategoryNodeOut]
    max_depth: int = Field(description="현재 계층의 최대 깊이")
    depth_limit: int = Field(description="허용 상한. 폭주 방지 안전장치")
