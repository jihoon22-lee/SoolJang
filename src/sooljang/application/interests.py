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
from sooljang.infrastructure.database.models.price_watch import PriceWatch
from sooljang.infrastructure.external.safe_http import UnsafeRequest, validate_url
from sooljang.infrastructure.external.search import canonical_document_url


def interest_out(row: Interest) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "identity": row.identity,
        "source_matches": row.source_matches,
        "reference_urls": row.reference_urls,
        "note": row.note,
        "archived": row.archived_at is not None,
        "deleted": row.deleted_at is not None,
        "created_at": row.created_at,
        "product_id": str(row.product_id) if row.product_id else None,
        "updated_at": row.updated_at,
    }


async def load_interest(
    session: AsyncSession,
    user_id: uuid.UUID,
    interest_id: uuid.UUID,
    *,
    include_deleted: bool = False,
) -> Interest:
    query = select(Interest).where(Interest.id == interest_id, Interest.user_id == user_id)
    if not include_deleted:
        query = query.where(Interest.deleted_at.is_(None))
    row = await session.scalar(query.with_for_update().execution_options(populate_existing=True))
    if row is None:
        raise NotFoundError("관심 기록을 찾을 수 없습니다")
    return row


def validated_references(values: list[str]) -> list[str]:
    urls = []
    for value in values:
        url = canonical_document_url(value)
        if url is None:
            raise ValidationFailedError("참고 출처는 비밀값 없는 공개 HTTP(S) URL이어야 합니다")
        if url not in urls:
            urls.append(url)
    return urls


async def pause_interest_watches(session: AsyncSession, row: Interest) -> None:
    """이전 식별값의 조회·대기 푸시를 취소하되 실제 관측과 전환 영수증을 보존한다."""
    from sooljang.application.price_watch import update_watch

    watches = await session.scalars(
        select(PriceWatch)
        .where(
            PriceWatch.interest_id == row.id,
            PriceWatch.user_id == row.user_id,
            PriceWatch.deleted_at.is_(None),
        )
        .order_by(PriceWatch.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    for watch in watches:
        await update_watch(
            session,
            user_id=row.user_id,
            watch_id=watch.id,
            expected_revision=watch.config_revision,
            fields={"is_active": False, "schedule_enabled": False, "push_enabled": False},
        )


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
    reference_urls: list[str] | None = None,
) -> Interest:
    await validate_source_matches(session, user_id, source_matches)
    references = validated_references(reference_urls or [])
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
            reference_urls=references,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
    row = await load_interest(session, user_id, interest_id)
    if (
        row.identity != identity
        or row.source_matches != source_matches
        or row.note != note
        or row.reference_urls != references
    ):
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

    # 구버전 JSON의 빠진 optional 필드와 새 클라이언트의 빈 optional 필드는 같다.
    def meaningful(value: dict[str, Any]) -> dict[str, Any]:
        return {key: item for key, item in value.items() if item not in (None, [], "")}

    identity_changed = "identity" in fields and meaningful(fields["identity"]) != meaningful(
        row.identity
    )
    pins_changed = "source_matches" in fields and fields["source_matches"] != row.source_matches
    if identity_changed or pins_changed or fields.get("archived") is True:
        await pause_interest_watches(session, row)
    if identity_changed:
        # 이전 판본의 사용자 고정을 새 판본으로 암묵적으로 이전하지 않는다.
        row.source_matches = {}
    if "source_matches" in fields and not identity_changed:
        await validate_source_matches(session, user_id, fields["source_matches"])
        row.source_matches = fields["source_matches"]
    if "identity" in fields:
        row.identity = fields["identity"]
        row.name = fields["identity"]["name"]
    if "reference_urls" in fields:
        row.reference_urls = validated_references(fields["reference_urls"])
    if "note" in fields:
        row.note = fields["note"]
    if fields.get("archived") is not None:
        row.archived_at = datetime.datetime.now(datetime.UTC) if fields["archived"] else None
    await session.flush()
    await session.refresh(row)
    return row


async def set_interest_deleted(
    session: AsyncSession,
    user_id: uuid.UUID,
    interest_id: uuid.UUID,
    *,
    expected_updated_at: datetime.datetime,
    deleted: bool,
) -> Interest:
    row = await load_interest(session, user_id, interest_id, include_deleted=True)
    if row.updated_at != expected_updated_at:
        raise ConflictError("관심 기록이 변경되었습니다. 최신 기록을 확인하세요")
    if deleted:
        await pause_interest_watches(session, row)
    row.deleted_at = datetime.datetime.now(datetime.UTC) if deleted else None
    await session.flush()
    await session.refresh(row)
    return row
