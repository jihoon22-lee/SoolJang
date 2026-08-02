"""저장된 피벗 뷰 라우터(Task 20)."""

import uuid

from fastapi import APIRouter, status

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.schemas.saved_views import SavedViewIn, SavedViewOut, SavedViewUpdate
from sooljang.application.saved_views import (
    create_saved_view,
    delete_saved_view,
    list_saved_views,
    update_saved_view,
)

router = APIRouter(prefix="/saved-views", tags=["saved-views"])


@router.get("", response_model=list[SavedViewOut], summary="저장된 뷰 목록")
async def list_views(session: SessionDep, user_id: UserDep) -> list[SavedViewOut]:
    views = await list_saved_views(session, user_id=user_id)
    return [SavedViewOut.model_validate(view) for view in views]


@router.post(
    "", response_model=SavedViewOut, status_code=status.HTTP_201_CREATED, summary="뷰 저장"
)
async def create_view(payload: SavedViewIn, session: SessionDep, user_id: UserDep) -> SavedViewOut:
    view = await create_saved_view(
        session, user_id=user_id, name=payload.name, definition=payload.definition
    )
    return SavedViewOut.model_validate(view)


@router.patch("/{view_id}", response_model=SavedViewOut, summary="뷰 이름·정의 수정")
async def update_view(
    view_id: uuid.UUID, payload: SavedViewUpdate, session: SessionDep, user_id: UserDep
) -> SavedViewOut:
    view = await update_saved_view(
        session,
        user_id=user_id,
        view_id=view_id,
        name=payload.name,
        definition=payload.definition,
    )
    return SavedViewOut.model_validate(view)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT, summary="뷰 삭제")
async def remove_view(view_id: uuid.UUID, session: SessionDep, user_id: UserDep) -> None:
    await delete_saved_view(session, user_id=user_id, view_id=view_id)
