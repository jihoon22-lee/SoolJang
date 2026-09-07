"""설정 → API·외부 연결. 등록·검증·활성은 서로 다른 작업이다."""

import uuid
from typing import cast

from fastapi import APIRouter, status
from sqlalchemy import select

from sooljang.api.deps import SessionDep, SettingsDep, UserDep
from sooljang.api.schemas.provider_connections import (
    ConnectionCreate,
    ConnectionProbeOut,
    ConnectionUpdate,
    CredentialFieldOut,
    ProviderConnectionOut,
    ProviderDefinitionOut,
    ProviderKind,
    RevisionRequest,
)
from sooljang.application.provider_connections import (
    attach_source,
    connection_view,
    create_connection,
    get_owned_connection,
    probe_connection,
    remove_connection,
    update_connection,
)
from sooljang.infrastructure.database.models import ProviderConnection
from sooljang.infrastructure.external.providers import PROVIDERS

router = APIRouter(prefix="/connections", tags=["connections"])


@router.get("/providers", response_model=list[ProviderDefinitionOut])
async def providers() -> list[ProviderDefinitionOut]:
    return [
        ProviderDefinitionOut(
            kind=cast(ProviderKind, provider.kind),
            label=provider.label,
            fields=[
                CredentialFieldOut(name=field.name, label=field.label) for field in provider.fields
            ],
            features=list(provider.features),
            guide_url=provider.guide_url,
            note=provider.note,
            probe_supported=provider.probe_supported,
        )
        for provider in PROVIDERS
    ]


@router.get("", response_model=list[ProviderConnectionOut])
async def list_connections(session: SessionDep, user_id: UserDep) -> list[ProviderConnectionOut]:
    connections = await session.scalars(
        select(ProviderConnection)
        .where(
            ProviderConnection.user_id == user_id,
            ProviderConnection.deleted_at.is_(None),
        )
        .order_by(ProviderConnection.created_at, ProviderConnection.id)
    )
    return [
        ProviderConnectionOut.model_validate(await connection_view(session, connection))
        for connection in connections
    ]


@router.post("", response_model=ProviderConnectionOut, status_code=status.HTTP_201_CREATED)
async def register_connection(
    payload: ConnectionCreate, session: SessionDep, user_id: UserDep, settings: SettingsDep
) -> ProviderConnectionOut:
    connection = await create_connection(
        session,
        user_id=user_id,
        provider_kind=payload.provider_kind,
        name=payload.name,
        values={name: value.get_secret_value() for name, value in payload.credentials.items()},
        master_key=settings.secret_key,
    )
    return ProviderConnectionOut.model_validate(await connection_view(session, connection))


@router.get("/{connection_id}", response_model=ProviderConnectionOut)
async def read_connection(
    connection_id: uuid.UUID, session: SessionDep, user_id: UserDep
) -> ProviderConnectionOut:
    connection = await get_owned_connection(session, user_id=user_id, connection_id=connection_id)
    return ProviderConnectionOut.model_validate(await connection_view(session, connection))


@router.patch("/{connection_id}", response_model=ProviderConnectionOut)
async def edit_connection(
    connection_id: uuid.UUID,
    payload: ConnectionUpdate,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
) -> ProviderConnectionOut:
    connection = await update_connection(
        session,
        user_id=user_id,
        connection_id=connection_id,
        expected_revision=payload.expected_revision,
        fields=payload.model_dump(
            exclude_unset=True, exclude={"credentials", "delete_credentials", "expected_revision"}
        ),
        values={name: value.get_secret_value() for name, value in payload.credentials.items()},
        delete_credentials=payload.delete_credentials,
        master_key=settings.secret_key,
    )
    return ProviderConnectionOut.model_validate(await connection_view(session, connection))


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect(
    connection_id: uuid.UUID, payload: RevisionRequest, session: SessionDep, user_id: UserDep
) -> None:
    await remove_connection(
        session,
        user_id=user_id,
        connection_id=connection_id,
        expected_revision=payload.expected_revision,
    )


@router.put("/{connection_id}/sources/{source_id}", response_model=ProviderConnectionOut)
async def share_connection(
    connection_id: uuid.UUID,
    source_id: uuid.UUID,
    payload: RevisionRequest,
    session: SessionDep,
    user_id: UserDep,
) -> ProviderConnectionOut:
    connection = await attach_source(
        session,
        user_id=user_id,
        connection_id=connection_id,
        source_id=source_id,
        expected_revision=payload.expected_revision,
    )
    return ProviderConnectionOut.model_validate(await connection_view(session, connection))


@router.post("/{connection_id}/probe", response_model=ConnectionProbeOut)
async def test_connection(
    connection_id: uuid.UUID,
    payload: RevisionRequest,
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
) -> ConnectionProbeOut:
    result = await probe_connection(
        session,
        user_id=user_id,
        connection_id=connection_id,
        expected_revision=payload.expected_revision,
        master_key=settings.secret_key,
    )
    return ConnectionProbeOut(
        outcome=result.outcome, tested_revision=result.tested_revision, applied=result.applied
    )
