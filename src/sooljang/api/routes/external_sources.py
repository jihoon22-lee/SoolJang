"""외부 소스 레지스트리 CRUD + 온디맨드 조회 라우터(Task 18, 매칭 고정은 Task 34 PR1).

조회(`POST /products/{id}/external-lookup`)는 사용자가 제품 상세의 "외부 정보" 버튼을
누른 시점에만 호출된다 — `docs/architecture.md` §7.3 이 요구하는 "조회는 사용자 조작
시점에만" 규칙을 라우팅 자체로 지킨다(자동 폴링·백그라운드 호출 없음).
"""

import uuid

from fastapi import APIRouter, status

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import NotFoundError
from sooljang.api.schemas.external_sources import (
    ExternalProductMatchCreate,
    ExternalProductMatchOut,
    ExternalSourceCreate,
    ExternalSourceOut,
    ExternalSourceUpdate,
    LookupCandidateOut,
    SourceLookupOut,
)
from sooljang.application.external_sources import (
    create_source,
    delete_source,
    get_owned_source,
    list_sources,
    lookup_product,
    pin_match,
    unpin_match,
    update_source,
)
from sooljang.application.products import load_product

router = APIRouter(prefix="/external-sources", tags=["external-sources"])
lookup_router = APIRouter(prefix="/products", tags=["external-sources"])


@router.get("", response_model=list[ExternalSourceOut], summary="외부 소스 목록")
async def list_external_sources(session: SessionDep, user_id: UserDep) -> list[ExternalSourceOut]:
    sources = await list_sources(session, user_id=user_id)
    return [ExternalSourceOut.model_validate(source) for source in sources]


@router.post(
    "",
    response_model=ExternalSourceOut,
    status_code=status.HTTP_201_CREATED,
    summary="외부 소스 등록",
)
async def create_external_source(
    payload: ExternalSourceCreate, session: SessionDep, user_id: UserDep
) -> ExternalSourceOut:
    source = await create_source(
        session,
        user_id=user_id,
        name=payload.name.strip(),
        base_url=payload.base_url.strip(),
        adapter_spec=payload.adapter_spec,
        category_id=payload.category_id,
        priority=payload.priority,
        is_active=payload.is_active,
        rate_limit_per_min=payload.rate_limit_per_min,
        ttl_hours=payload.ttl_hours,
        note=payload.note,
    )
    return ExternalSourceOut.model_validate(source)


@router.patch("/{source_id}", response_model=ExternalSourceOut, summary="외부 소스 수정")
async def update_external_source(
    source_id: uuid.UUID, payload: ExternalSourceUpdate, session: SessionDep, user_id: UserDep
) -> ExternalSourceOut:
    source = await get_owned_source(session, user_id=user_id, source_id=source_id)
    if source is None:
        raise NotFoundError(f"외부 소스를 찾을 수 없습니다: {source_id}")
    source = await update_source(
        session, source, user_id=user_id, fields=payload.model_dump(exclude_unset=True)
    )
    return ExternalSourceOut.model_validate(source)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT, summary="외부 소스 삭제")
async def delete_external_source(
    source_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> None:
    source = await get_owned_source(session, user_id=user_id, source_id=source_id)
    if source is None:
        raise NotFoundError(f"외부 소스를 찾을 수 없습니다: {source_id}")
    await delete_source(session, source)
    await session.flush()


@lookup_router.post(
    "/{product_id}/external-lookup",
    response_model=list[SourceLookupOut],
    summary="제품에 대해 등록된 외부 소스를 조회",
)
async def lookup_external_sources(
    product_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> list[SourceLookupOut]:
    product = await load_product(session, user_id=user_id, product_id=product_id)
    results = await lookup_product(session, user_id=user_id, product=product)
    return [
        SourceLookupOut(
            source_id=result.source_id,
            source_name=result.source_name,
            cached=result.cached,
            source_url=result.source_url,
            fields=result.fields,
            raw_excerpt=result.raw_excerpt,
            degraded=result.degraded,
            warning=result.warning,
            fetched_at=result.fetched_at,
            matched_name=result.matched_name,
            match_score=result.match_score,
            needs_confirmation=result.needs_confirmation,
            pinned=result.pinned,
            candidates=[
                LookupCandidateOut(name=c.name, url=c.url, key=c.key, score=c.score)
                for c in result.candidates
            ],
        )
        for result in results
    ]


@lookup_router.post(
    "/{product_id}/external-matches",
    response_model=ExternalProductMatchOut,
    status_code=status.HTTP_201_CREATED,
    summary="제품에 외부 소스의 특정 상품을 고정",
)
async def create_external_match(
    product_id: uuid.UUID,
    payload: ExternalProductMatchCreate,
    session: SessionDep,
    user_id: UserDep,
) -> ExternalProductMatchOut:
    match = await pin_match(
        session,
        user_id=user_id,
        product_id=product_id,
        source_id=payload.source_id,
        external_url=payload.external_url,
        external_name=payload.external_name,
        external_key=payload.external_key,
    )
    return ExternalProductMatchOut.model_validate(match)


@lookup_router.delete(
    "/{product_id}/external-matches/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="제품의 외부 소스 고정을 해제",
)
async def delete_external_match(
    product_id: uuid.UUID, source_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> None:
    await unpin_match(session, user_id=user_id, product_id=product_id, source_id=source_id)
