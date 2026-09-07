"""인증된 앱 내 비생성 탐색. 검색 응답은 브라우저/서버 캐시에 보관하지 않는다."""

import uuid
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Response

from sooljang.api.deps import SessionDep, SettingsDep, UserDep
from sooljang.api.schemas.discovery import (
    ApplyEvidenceInput,
    IdentityLookupInput,
    InterestLookupInput,
    SearchInput,
)
from sooljang.api.schemas.external_sources import SourceLookupOut
from sooljang.application import discovery as service
from sooljang.application.discovery_evidence import (
    applicable_fields,
    apply_evidence,
    issue_evidence,
)
from sooljang.application.external_sources import SourceLookupResult
from sooljang.application.interests import validate_source_matches
from sooljang.infrastructure.database.models import ExternalSource, ProviderConnection

router = APIRouter(prefix="/discovery", tags=["discovery"])


@router.post("/search")
async def search(
    payload: SearchInput,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
    response: Response,
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    result = await service.search_connection(
        session, user_id=user_id, master_key=settings.secret_key, **payload.model_dump()
    )
    return {"connection_id": str(payload.connection_id), **asdict(result)}


async def _outputs(
    results: list[SourceLookupResult],
    session: SessionDep,
    user_id: uuid.UUID,
    master_key: str,
) -> list[dict[str, Any]]:
    outputs = []
    for result in results:
        output = SourceLookupOut.model_validate(asdict(result)).model_dump(mode="json")
        output["applicable_fields"] = applicable_fields(result.fields)
        output["evidence_token"] = None
        if result.source_url and output["applicable_fields"] and not result.degraded:
            source = await session.get(ExternalSource, result.source_id)
            if source is not None:
                connection = (
                    await session.get(ProviderConnection, source.connection_id)
                    if source.connection_id
                    else None
                )
                output["evidence_token"] = issue_evidence(
                    user_id=user_id,
                    source=source,
                    fields=result.fields,
                    source_url=result.source_url,
                    master_key=master_key,
                    connection_revision=connection.config_revision if connection else None,
                )
        outputs.append(output)
    return outputs


@router.post("/lookup")
async def lookup(
    payload: IdentityLookupInput,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
    response: Response,
) -> list[dict[str, Any]]:
    response.headers["Cache-Control"] = "no-store"
    matches = {str(key): value.model_dump() for key, value in payload.source_matches.items()}
    await validate_source_matches(session, user_id, matches)
    results = await service.lookup_identity(
        session,
        user_id=user_id,
        identity=service.identity_from_fields(payload.identity.model_dump(mode="json")),
        source_ids=payload.source_ids,
        matches=matches,
        master_key=settings.secret_key,
    )
    return await _outputs(results, session, user_id, settings.secret_key)


@router.post("/interests/{interest_id}/lookup")
async def interest_lookup(
    interest_id: uuid.UUID,
    payload: InterestLookupInput,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
    response: Response,
) -> list[dict[str, Any]]:
    response.headers["Cache-Control"] = "no-store"
    results = await service.lookup_interest(
        session,
        user_id=user_id,
        interest_id=interest_id,
        master_key=settings.secret_key,
        source_ids=payload.source_ids,
    )
    return await _outputs(results, session, user_id, settings.secret_key)


@router.post("/apply")
async def apply(
    payload: ApplyEvidenceInput,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
    response: Response,
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await apply_evidence(
        session,
        user_id=user_id,
        product_id=payload.product_id,
        expected_updated_at=payload.expected_updated_at,
        token=payload.evidence_token,
        selected_fields=list(payload.selected_fields),
        master_key=settings.secret_key,
    )
