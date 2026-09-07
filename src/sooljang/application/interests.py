"""관심 CRUD와 출처 고정. 구매·실사 모델에 의존하지 않는다."""

import datetime
import uuid
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.infrastructure.database.models.external_source import ExternalSource
from sooljang.infrastructure.database.models.interest import Interest
from sooljang.infrastructure.external.safe_http import UnsafeRequest, validate_url


def interest_out(row: Interest) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "identity": row.identity,
        "source_matches": row.source_matches,
        "note": row.note,
        "archived": row.archived_at is not None,
        "product_id": str(row.product_id) if row.product_id else None,
        "updated_at": row.updated_at,
    }


async def load_interest(
    session: AsyncSession, user_id: uuid.UUID, interest_id: uuid.UUID
) -> Interest:
    row = await session.scalar(
        select(Interest)
        .where(
            Interest.id == interest_id, Interest.user_id == user_id, Interest.deleted_at.is_(None)
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise NotFoundError("관심 기록을 찾을 수 없습니다")
    return row


async def validate_source_matches(
    session: AsyncSession, user_id: uuid.UUID, matches: dict[str, Any]
) -> None:
    for source_id, match in matches.items():
        source = await session.scalar(
            select(ExternalSource)
            .where(
                ExternalSource.id == uuid.UUID(source_id),
                ExternalSource.user_id == user_id,
                ExternalSource.deleted_at.is_(None),
            )
            .with_for_update()
        )
        if source is None:
            raise NotFoundError("관심에 고정할 출처를 찾을 수 없습니다")
        try:
            parsed = httpx.URL(match["external_url"])
            # 저장 단계는 URL 구문과 공개 HTTP(S) 형태를 검증한다. 실제 조회 때는
            # 어댑터의 source host allowlist·DNS·연결 대상 검증을 별도로 거친다.
            validate_url(match["external_url"], frozenset({parsed.host}))
        except (UnsafeRequest, httpx.InvalidURL, ValueError) as exc:
            raise ValidationFailedError("출처 링크는 공개 HTTP(S) URL이어야 합니다") from exc


async def create_interest(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    identity: dict[str, Any],
    source_matches: dict[str, Any],
    note: str | None,
    request_id: str | None = None,
) -> Interest:
    await validate_source_matches(session, user_id, source_matches)
    interest_id = uuid.uuid5(user_id, f"interest:{request_id}") if request_id else uuid.uuid4()
    await session.execute(
        insert(Interest)
        .values(
            id=interest_id,
            user_id=user_id,
            name=identity["name"],
            identity=identity,
            source_matches=source_matches,
            note=note,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
    row = await load_interest(session, user_id, interest_id)
    if row.identity != identity or row.source_matches != source_matches or row.note != note:
        raise ConflictError("같은 요청 식별자로 다른 관심 기록을 저장할 수 없습니다")
    return row


async def update_interest(
    session: AsyncSession,
    user_id: uuid.UUID,
    interest_id: uuid.UUID,
    *,
    expected_updated_at: datetime.datetime,
    fields: dict[str, Any],
) -> Interest:
    row = await load_interest(session, user_id, interest_id)
    if row.updated_at != expected_updated_at:
        raise ConflictError("다른 화면에서 관심 기록을 변경했습니다. 최신 기록을 확인하세요")
    if "source_matches" in fields:
        await validate_source_matches(session, user_id, fields["source_matches"])
        row.source_matches = fields["source_matches"]
    if "identity" in fields:
        row.identity = fields["identity"]
        row.name = fields["identity"]["name"]
    if "note" in fields:
        row.note = fields["note"]
    if fields.get("archived") is not None:
        row.archived_at = datetime.datetime.now(datetime.UTC) if fields["archived"] else None
    await session.flush()
    await session.refresh(row)
    return row
