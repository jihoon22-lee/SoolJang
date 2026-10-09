"""여러 기존 부모를 쓰는 import·sync와 온라인 쓰기의 공통 진입 잠금."""

import hashlib
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession


async def lock_user_writes(session: AsyncSession, user_id: uuid.UUID) -> None:
    """행 잠금보다 먼저 얻는다. 기존 sync-user 키를 그대로 사용한다."""
    key = int.from_bytes(
        hashlib.blake2b(b"sync-user" + user_id.bytes, digest_size=8).digest(), signed=True
    )
    await session.execute(select(func.pg_advisory_xact_lock(key)))
