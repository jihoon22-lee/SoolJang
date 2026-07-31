"""FastAPI 의존성.

`current_user_id` 는 **Task 12(인증)에서 실제 세션 기반으로 교체된다.** 지금은 설정에서
고정 사용자 id 를 읽어 단일 사용자 개발을 진행할 수 있게 한다.

이 자리를 임시로 두는 대신 아예 생략하지 않는 이유는, 모든 쿼리가 처음부터 `user_id` 로
스코프되게 강제하기 위해서다. 나중에 인증을 붙일 때 스코프 누락을 찾아 헤매지 않는다.
"""

import uuid
from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.config import Settings, get_settings
from sooljang.infrastructure.database.session import get_session_factory


async def db_session() -> AsyncGenerator[AsyncSession]:
    """요청 범위 세션. 예외가 나면 롤백하고, 정상 종료 시 커밋한다."""
    async with get_session_factory()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


def settings_dependency() -> Settings:
    return get_settings()


def current_user_id(
    settings: Annotated[Settings, Depends(settings_dependency)],
) -> uuid.UUID:
    """현재 사용자 식별자.

    Task 12 에서 세션 쿠키 기반 인증으로 교체한다. 그때 이 함수만 바꾸면 모든 라우터가
    자동으로 실제 사용자를 쓰게 된다.
    """
    return settings.default_user_id


SessionDep = Annotated[AsyncSession, Depends(db_session)]
UserDep = Annotated[uuid.UUID, Depends(current_user_id)]
