"""새 탐색: 검색·허용된 소스 조회만 수행하며 생성형/개인 기록 전송 경로가 없다."""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.application.external_offers import last_observed_offers, record_offers
from sooljang.application.external_sources import SourceLookupResult, _fetch_source, _record_probe
from sooljang.application.provider_connections import (
    ConnectionChanged,
    get_owned_connection,
    get_request_credentials,
    reserve_connection_request,
)
from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.database.models import ExternalSource
from sooljang.infrastructure.database.models.interest import Interest
from sooljang.infrastructure.external.adapter import PinnedMatch
from sooljang.infrastructure.external.fields import split_fields
from sooljang.infrastructure.external.matching import ProductIdentity
from sooljang.infrastructure.external.search import SEARCH_KINDS, SearchResult, search_provider
from sooljang.infrastructure.security.secrets import InvalidToken


def identity_from_fields(fields: dict[str, Any]) -> ProductIdentity:
    return ProductIdentity(
        name=fields["name"],
        name_en=fields.get("name_en"),
        producer=fields.get("producer"),
        abv=Decimal(str(fields["abv"])) if fields.get("abv") is not None else None,
        vintage=fields.get("vintage"),
        age_years=Decimal(str(fields["age_years"]))
        if fields.get("age_years") is not None
        else None,
        volumes_ml=tuple(fields.get("volumes_ml", [])),
    )


async def search_connection(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    connection_id: uuid.UUID,
    query: str,
    master_key: str,
    page: int = 1,
    language: str = "ko",
    transport: httpx.AsyncBaseTransport | None = None,
) -> SearchResult:
    connection = await get_owned_connection(session, user_id=user_id, connection_id=connection_id)
    if connection.provider_kind not in SEARCH_KINDS:
        return SearchResult(
            SourceOutcome.INVALID_CONFIGURATION, warning="이 연결은 일반 검색을 지원하지 않습니다"
        )
    if not connection.is_active:
        return SearchResult(
            SourceOutcome.INVALID_CONFIGURATION, warning="비활성 연결을 건너뛰었습니다"
        )
    revision = connection.config_revision
    try:
        credentials = await get_request_credentials(
            session,
            user_id=user_id,
            connection_id=connection_id,
            master_key=master_key,
        )
    except InvalidToken, ValueError:
        return SearchResult(
            SourceOutcome.CREDENTIAL_UNAVAILABLE, warning="검색 연결의 인증 정보를 확인하세요"
        )

    async def before_request(_request: httpx.Request) -> None:
        await reserve_connection_request(
            session,
            user_id=user_id,
            connection_id=connection_id,
            expected_revision=revision,
        )

    try:
        async with asyncio.timeout(20):
            result = await search_provider(
                connection.provider_kind,
                credentials,
                query=query,
                page=page,
                language=language,
                before_request=before_request,
                transport=transport,
            )
    except ConnectionChanged:
        return SearchResult(
            SourceOutcome.INVALID_CONFIGURATION, warning="요청 중 연결 설정이 바뀌었습니다"
        )
    except TimeoutError:
        return SearchResult(SourceOutcome.NETWORK_ERROR, warning="검색 제한 시간을 초과했습니다")
    except ValueError:
        raise ValidationFailedError("검색 제공자의 페이지·검색명을 확인하세요") from None
    current_revision = await session.scalar(
        select(type(connection).config_revision).where(type(connection).id == connection_id)
    )
    if current_revision != revision:
        return SearchResult(
            SourceOutcome.INVALID_CONFIGURATION, warning="설정 변경 전의 검색 결과를 폐기했습니다"
        )
    return result


async def lookup_identity(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    identity: ProductIdentity,
    source_ids: list[uuid.UUID],
    master_key: str | None,
    matches: dict[str, Any] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[SourceLookupResult]:
    """미등록 대상의 일회성 조회. 소스는 호출자가 최대 4개를 명시적으로 선택한다."""
    if not 1 <= len(source_ids) <= 4:
        raise ValidationFailedError("한 번에 1~4개의 소스를 선택하세요")
    results = []
    for source_id in dict.fromkeys(source_ids):
        source = await session.scalar(
            select(ExternalSource).where(
                ExternalSource.id == source_id,
                ExternalSource.user_id == user_id,
                ExternalSource.deleted_at.is_(None),
            )
        )
        if source is None:
            raise NotFoundError("선택한 소스를 찾을 수 없습니다")
        if not source.is_active:
            results.append(
                SourceLookupResult(
                    source.id,
                    source.name,
                    False,
                    None,
                    {},
                    None,
                    True,
                    "비활성 소스를 건너뛰었습니다",
                    None,
                    outcome=SourceOutcome.INVALID_CONFIGURATION,
                )
            )
            continue
        raw_match = (matches or {}).get(str(source_id))
        pinned = PinnedMatch(**raw_match) if raw_match else None
        adapter = await _fetch_source(
            session,
            source=source,
            identity=identity,
            transport=transport,
            master_key=master_key,
            pinned=pinned,
        )
        fetched_at = datetime.now(UTC)
        await _record_probe(
            session,
            user_id=user_id,
            source_id=source_id,
            ok=adapter.ok,
            config_revision=source.config_revision,
            outcome=adapter.outcome,
            degraded=adapter.degraded,
            warning=adapter.warning,
            attempted_at=fetched_at,
        )
        results.append(
            SourceLookupResult(
                source.id,
                source.name,
                False,
                adapter.source_url,
                adapter.fields,
                adapter.raw_excerpt,
                adapter.degraded,
                adapter.warning,
                fetched_at,
                matched_name=adapter.matched_name,
                match_score=adapter.match_score,
                needs_confirmation=adapter.needs_confirmation,
                pinned=adapter.pinned,
                candidates=adapter.candidates,
                normalized=split_fields(adapter.fields),
                outcome=adapter.outcome,
                product_key=adapter.product_key,
                offers=[{**offer, "fetched_at": fetched_at.isoformat()} for offer in adapter.offers]
                if adapter.ok
                else [],
            )
        )
    return results


async def lookup_interest(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    interest_id: uuid.UUID,
    master_key: str | None,
    source_ids: list[uuid.UUID] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[SourceLookupResult]:
    interest = await session.scalar(
        select(Interest).where(
            Interest.id == interest_id,
            Interest.user_id == user_id,
            Interest.deleted_at.is_(None),
            Interest.archived_at.is_(None),
        )
    )
    if interest is None:
        raise NotFoundError("활성 관심 기록을 찾을 수 없습니다")
    revision = interest.updated_at
    identity = identity_from_fields(interest.identity)
    selected = (
        source_ids
        if source_ids is not None
        else [uuid.UUID(key) for key in interest.source_matches]
    )
    results = await lookup_identity(
        session,
        user_id=user_id,
        identity=identity,
        source_ids=selected,
        master_key=master_key,
        matches=interest.source_matches,
        transport=transport,
    )
    # 네트워크 중에는 관심 편집을 막지 않는다. 저장 직전에 최신 revision을 잠가 확인한다.
    current = await session.scalar(
        select(Interest)
        .where(Interest.id == interest_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        current is None
        or current.updated_at != revision
        or current.archived_at
        or current.deleted_at
    ):
        raise ConflictError("조회 중 관심 기록이 변경되었습니다. 최신 대상으로 다시 조회하세요")
    for result in results:
        source = await session.get(ExternalSource, result.source_id, populate_existing=True)
        if source is None or not source.price_history_allowed:
            continue
        if result.offers and result.fetched_at is not None:
            result.offers = await record_offers(
                session,
                user_id=user_id,
                source_id=result.source_id,
                product_id=None,
                interest_id=interest_id,
                fetched_at=result.fetched_at,
                offers=result.offers,
            )
        elif result.degraded:
            pinned = current.source_matches.get(str(result.source_id), {})
            result.offers = await last_observed_offers(
                session,
                user_id=user_id,
                source_id=result.source_id,
                product_id=None,
                interest_id=interest_id,
                identity=identity,
                pinned_product_key=pinned.get("product_key"),
            )
    return results
