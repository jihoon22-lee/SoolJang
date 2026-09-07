"""연결 등록·설정 변경·검증과 기존 source/OCR의 호환 경계.

ciphertext는 이전 시 그대로 복사하며 기존 원장을 통해 들어온 수정도 같은 연결 revision을
갱신한다. GET 응답은 상태와 힌트뿐이고 원문은 송신 직전의 서버 전용 경로에서만 해독한다.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import delete, select, true, update
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError, NotFoundError, ValidationFailedError
from sooljang.application.external_request_usage import (
    RequestBudget,
    current_usage,
    reserve_request,
)
from sooljang.domain.discovery import RequestBudgetExceeded, SourceOutcome
from sooljang.infrastructure.database.models import (
    DEFAULT_OPENAI_MODEL,
    DEFAULT_REMATCH_MONTHLY_CAP,
    ExternalSource,
    ExternalSourceCredential,
    LlmProvider,
    LlmSetting,
    ProviderConnection,
    ProviderCredential,
)
from sooljang.infrastructure.external.presets import get_preset
from sooljang.infrastructure.external.providers import provider_definition, test_provider_connection
from sooljang.infrastructure.security.secrets import InvalidToken, decrypt_secret, encrypt_secret


class ConnectionLimitError(ConflictError):
    status_code = 429
    error_type = "connection-limit"
    title = "연결 요청 상한에 도달했습니다"


class ConnectionChanged(httpx.RequestError):
    """중지·삭제·설정 교체 뒤 진행 중 요청의 다음 송신을 차단한다."""


@dataclass(frozen=True)
class ConnectionProbe:
    outcome: SourceOutcome
    tested_revision: int
    applied: bool


def legacy_connection_id(kind: str, identity: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:{kind}:{identity}")


def _hint(value: str) -> str:
    return value[-4:] if len(value) > 4 else ""


def _required_source_fields(source: ExternalSource) -> list[str]:
    entries = source.adapter_spec.get("credentials", [])
    return (
        list(
            dict.fromkeys(
                entry["name"]
                for entry in entries
                if isinstance(entry, dict) and isinstance(entry.get("name"), str)
            )
        )
        if isinstance(entries, list)
        else []
    )


async def get_owned_connection(
    session: AsyncSession, *, user_id: uuid.UUID, connection_id: uuid.UUID, lock: bool = False
) -> ProviderConnection:
    statement = select(ProviderConnection).where(
        ProviderConnection.id == connection_id,
        ProviderConnection.user_id == user_id,
        ProviderConnection.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    connection = await session.scalar(statement)
    if connection is None:
        raise NotFoundError("연결을 찾을 수 없습니다")
    return connection


async def _credential_rows(
    session: AsyncSession, connection: ProviderConnection
) -> list[ProviderCredential]:
    return list(
        await session.scalars(
            select(ProviderCredential).where(
                ProviderCredential.connection_id == connection.id,
                ProviderCredential.user_id == connection.user_id,
                ProviderCredential.deleted_at.is_(None),
            )
        )
    )


async def _put_ciphertext(
    session: AsyncSession, connection: ProviderConnection, name: str, ciphertext: bytes, hint: str
) -> bool:
    existing = await session.scalar(
        select(ProviderCredential).where(
            ProviderCredential.connection_id == connection.id,
            ProviderCredential.user_id == connection.user_id,
            ProviderCredential.name == name,
        )
    )
    if existing is None:
        session.add(
            ProviderCredential(
                user_id=connection.user_id,
                connection_id=connection.id,
                name=name,
                secret_ciphertext=ciphertext,
                hint=hint,
            )
        )
        await session.flush()
        return True
    changed = existing.secret_ciphertext != ciphertext or existing.deleted_at is not None
    existing.secret_ciphertext = ciphertext
    existing.hint = hint
    existing.deleted_at = None
    return changed


async def ensure_source_connection(
    session: AsyncSession, source: ExternalSource
) -> ProviderConnection:
    """구 원장 입력/직접 등록의 호환 경로. 힌트가 같아도 다른 source는 다른 프로필이다."""
    if source.connection_id is not None:
        return await get_owned_connection(
            session, user_id=source.user_id, connection_id=source.connection_id
        )
    connection_id = legacy_connection_id("source", source.id)
    connection = await session.get(ProviderConnection, connection_id)
    if connection is None:
        required = _required_source_fields(source)
        connection = ProviderConnection(
            id=connection_id,
            user_id=source.user_id,
            name=source.name,
            provider_kind="dailyshot"
            if source.preset_key == "dailyshot" and not required
            else "source",
            is_active=source.is_active,
            config_revision=source.config_revision,
            rate_limit_per_min=source.rate_limit_per_min,
            request_limit_per_day=source.request_limit_per_day,
            required_fields=required,
            origin_kind="source",
            origin_id=source.id,
        )
        session.add(connection)
        await session.flush()
        rows = await session.scalars(
            select(ExternalSourceCredential).where(
                ExternalSourceCredential.source_id == source.id,
                ExternalSourceCredential.user_id == source.user_id,
                ExternalSourceCredential.deleted_at.is_(None),
            )
        )
        for row in rows:
            await _put_ciphertext(session, connection, row.name, row.secret_ciphertext, row.hint)
    source.connection_id = connection.id
    await session.flush()
    return connection


async def ensure_llm_connection(session: AsyncSession, setting: LlmSetting) -> ProviderConnection:
    if setting.connection_id is not None:
        return await get_owned_connection(
            session, user_id=setting.user_id, connection_id=setting.connection_id
        )
    connection_id = legacy_connection_id("llm", setting.id)
    connection = await session.get(ProviderConnection, connection_id)
    if connection is None:
        connection = ProviderConnection(
            id=connection_id,
            user_id=setting.user_id,
            name="OpenAI · 라벨 인식",
            provider_kind="openai_ocr",
            is_active=True,
            required_fields=["api_key"],
            origin_kind="llm",
            origin_id=setting.id,
        )
        session.add(connection)
        await session.flush()
        await _put_ciphertext(
            session, connection, "api_key", setting.api_key_ciphertext, setting.api_key_hint
        )
    setting.connection_id = connection.id
    await session.flush()
    await session.refresh(setting, ["updated_at"])
    return connection


async def _invalidate_sources(
    session: AsyncSession,
    connection: ProviderConnection,
    *,
    exclude_source_id: uuid.UUID | None = None,
) -> None:
    await session.execute(
        update(ExternalSource)
        .where(
            ExternalSource.connection_id == connection.id,
            ExternalSource.user_id == connection.user_id,
            ExternalSource.deleted_at.is_(None),
            ExternalSource.id != exclude_source_id if exclude_source_id else true(),
        )
        .values(config_revision=ExternalSource.config_revision + 1)
    )


async def sync_legacy_source_credentials(session: AsyncSession, source: ExternalSource) -> None:
    connection = await ensure_source_connection(session, source)
    changed = False
    rows = await session.scalars(
        select(ExternalSourceCredential).where(
            ExternalSourceCredential.source_id == source.id,
            ExternalSourceCredential.user_id == source.user_id,
            ExternalSourceCredential.deleted_at.is_(None),
        )
    )
    for row in rows:
        changed |= await _put_ciphertext(
            session, connection, row.name, row.secret_ciphertext, row.hint
        )
    required = _required_source_fields(source)
    if required != connection.required_fields:
        connection.required_fields = required
        changed = True
    if changed:
        connection.config_revision += 1
        await _mirror_credentials(session, connection)
        await _invalidate_sources(session, connection, exclude_source_id=source.id)
    await session.flush()


async def sync_legacy_llm_setting(session: AsyncSession, setting: LlmSetting) -> None:
    connection = await ensure_llm_connection(session, setting)
    changed = await _put_ciphertext(
        session, connection, "api_key", setting.api_key_ciphertext, setting.api_key_hint
    )
    if changed:
        connection.config_revision += 1
    await session.flush()
    await session.refresh(setting, ["updated_at"])


async def _mirror_credentials(session: AsyncSession, connection: ProviderConnection) -> None:
    """호환 API/구 이미지가 오래된 키를 되살리지 않도록 명시 수정·삭제를 원장에도 반영한다."""
    credentials = {row.name: row for row in await _credential_rows(session, connection)}
    sources = await session.scalars(
        select(ExternalSource).where(
            ExternalSource.connection_id == connection.id,
            ExternalSource.user_id == connection.user_id,
            ExternalSource.deleted_at.is_(None),
        )
    )
    for source in sources:
        old = list(
            await session.scalars(
                select(ExternalSourceCredential).where(
                    ExternalSourceCredential.source_id == source.id,
                    ExternalSourceCredential.user_id == connection.user_id,
                    ExternalSourceCredential.deleted_at.is_(None),
                )
            )
        )
        for row in old:
            if row.name not in credentials:
                await session.delete(row)
        for name, credential in credentials.items():
            row = next((entry for entry in old if entry.name == name), None)
            if row is None:
                session.add(
                    ExternalSourceCredential(
                        user_id=connection.user_id,
                        source_id=source.id,
                        name=name,
                        secret_ciphertext=credential.secret_ciphertext,
                        hint=credential.hint,
                    )
                )
            else:
                row.secret_ciphertext = credential.secret_ciphertext
                row.hint = credential.hint
    if connection.provider_kind == "openai_ocr":
        setting = await session.scalar(
            select(LlmSetting)
            .where(
                LlmSetting.connection_id == connection.id,
                LlmSetting.user_id == connection.user_id,
            )
            .order_by(LlmSetting.created_at.desc())
            .limit(1)
        )
        credential = credentials.get("api_key")
        if credential is None:
            if setting is not None:
                setting.deleted_at = datetime.now(UTC)
        elif setting is None:
            setting = LlmSetting(
                user_id=connection.user_id,
                connection_id=connection.id,
                provider=LlmProvider.OPENAI,
                api_key_ciphertext=credential.secret_ciphertext,
                api_key_hint=credential.hint,
                model=DEFAULT_OPENAI_MODEL,
            )
            session.add(setting)
        else:
            setting.api_key_ciphertext = credential.secret_ciphertext
            setting.api_key_hint = credential.hint
            setting.deleted_at = None
    await session.flush()


async def create_connection(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    provider_kind: str,
    name: str,
    values: Mapping[str, str],
    master_key: str,
) -> ProviderConnection:
    definition = provider_definition(provider_kind)
    if provider_kind == "source":
        raise ValidationFailedError("직접 등록 소스는 고급 소스 설정에서 추가하세요")
    if set(values) - {field.name for field in definition.fields}:
        raise ValidationFailedError("이 제공자에 없는 인증 항목입니다")
    connection = ProviderConnection(
        user_id=user_id,
        name=name.strip() or definition.label,
        provider_kind=provider_kind,
        required_fields=[field.name for field in definition.fields],
        is_active=False,
    )
    session.add(connection)
    await session.flush()
    for field, value in values.items():
        if value.strip():
            await _put_ciphertext(
                session,
                connection,
                field,
                encrypt_secret(value, master_key=master_key),
                _hint(value),
            )
    if provider_kind == "dailyshot":
        preset = get_preset("dailyshot")
        assert preset is not None
        session.add(
            ExternalSource(
                user_id=user_id,
                connection_id=connection.id,
                name=connection.name,
                base_url=preset.base_url,
                adapter_spec=preset.adapter_spec,
                preset_key=preset.key,
                preset_version=preset.version,
                is_active=True,
                spec_overridden=False,
            )
        )
    await _mirror_credentials(session, connection)
    return connection


async def _check_expected(connection: ProviderConnection, expected_revision: int) -> None:
    if connection.config_revision != expected_revision:
        raise ConflictError(
            "다른 곳에서 연결 설정이 바뀌었습니다. 최신 상태를 확인한 뒤 다시 저장하세요"
        )


async def update_connection(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    connection_id: uuid.UUID,
    expected_revision: int,
    fields: dict[str, Any],
    values: Mapping[str, str],
    delete_credentials: list[str],
    master_key: str,
) -> ProviderConnection:
    connection = await get_owned_connection(
        session, user_id=user_id, connection_id=connection_id, lock=True
    )
    await _check_expected(connection, expected_revision)
    available_names = set(connection.required_fields)
    available_names.update(row.name for row in await _credential_rows(session, connection))
    if (set(values) | set(delete_credentials)) - available_names:
        raise ValidationFailedError("연결에 없는 인증 항목입니다")
    if set(values) & set(delete_credentials):
        raise ValidationFailedError("같은 인증 항목을 교체와 삭제에 함께 지정할 수 없습니다")
    changed = False
    for name, value in values.items():
        if value.strip():
            changed |= await _put_ciphertext(
                session,
                connection,
                name,
                encrypt_secret(value, master_key=master_key),
                _hint(value),
            )
    for name in delete_credentials:
        result = await session.execute(
            delete(ProviderCredential)
            .where(
                ProviderCredential.connection_id == connection.id,
                ProviderCredential.user_id == user_id,
                ProviderCredential.name == name,
            )
            .returning(ProviderCredential.id)
        )
        changed |= result.first() is not None
    ocr_fields = {key: fields.pop(key) for key in list(fields) if key.startswith("ocr_")}
    if ocr_fields and connection.provider_kind != "openai_ocr":
        raise ValidationFailedError("라벨 인식 연결에서만 사용하는 설정입니다")
    for name, value in fields.items():
        if getattr(connection, name) != value:
            setattr(connection, name, value)
            changed = True
    await _mirror_credentials(session, connection)
    if ocr_fields:
        setting = await session.scalar(
            select(LlmSetting)
            .where(
                LlmSetting.connection_id == connection.id,
                LlmSetting.user_id == user_id,
            )
            .order_by(LlmSetting.created_at.desc())
            .limit(1)
        )
        if setting is None:
            raise ValidationFailedError("라벨 인식 설정을 저장하려면 먼저 API 키를 등록하세요")
        for field, attribute in (
            ("ocr_model", "model"),
            ("ocr_rematch_enabled", "rematch_enabled"),
            ("ocr_rematch_monthly_cap", "rematch_monthly_cap"),
        ):
            if field in ocr_fields and getattr(setting, attribute) != ocr_fields[field]:
                setattr(setting, attribute, ocr_fields[field])
                changed = True
    if connection.is_active and connection.provider_kind == "openai_ocr":
        # 사용 프로필 전환은 명시 활성화 요청일 때만 한다. 나머지 키·설정은 보존한다.
        await session.execute(
            update(ProviderConnection)
            .where(
                ProviderConnection.user_id == user_id,
                ProviderConnection.provider_kind == "openai_ocr",
                ProviderConnection.id != connection.id,
                ProviderConnection.is_active.is_(True),
                ProviderConnection.deleted_at.is_(None),
            )
            .values(is_active=False, config_revision=ProviderConnection.config_revision + 1)
        )
    if changed:
        connection.config_revision += 1
        await _invalidate_sources(session, connection)
    await session.flush()
    return connection


async def remove_connection(
    session: AsyncSession, *, user_id: uuid.UUID, connection_id: uuid.UUID, expected_revision: int
) -> None:
    connection = await get_owned_connection(
        session, user_id=user_id, connection_id=connection_id, lock=True
    )
    await _check_expected(connection, expected_revision)
    await session.execute(
        delete(ProviderCredential).where(
            ProviderCredential.connection_id == connection.id,
            ProviderCredential.user_id == user_id,
        )
    )
    await _mirror_credentials(session, connection)
    connection.is_active = False
    connection.deleted_at = datetime.now(UTC)
    connection.config_revision += 1
    await _invalidate_sources(session, connection)
    # 출처와 사용자 고정은 삭제하지 않는다. 삭제된 연결을 참조하면 송신을 막는다.
    await session.flush()


async def attach_source(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    connection_id: uuid.UUID,
    source_id: uuid.UUID,
    expected_revision: int,
) -> ProviderConnection:
    connection = await get_owned_connection(
        session, user_id=user_id, connection_id=connection_id, lock=True
    )
    await _check_expected(connection, expected_revision)
    source = await session.scalar(
        select(ExternalSource)
        .where(
            ExternalSource.id == source_id,
            ExternalSource.user_id == user_id,
            ExternalSource.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if source is None:
        raise NotFoundError("외부 소스를 찾을 수 없습니다")
    await validate_source_connection(session, source, connection)
    if set(_required_source_fields(source)) - set(connection.required_fields):
        raise ValidationFailedError("소스의 인증 항목과 연결의 항목이 일치하지 않습니다")
    if source.connection_id != connection.id:
        source.connection_id = connection.id
        source.config_revision += 1
        connection.config_revision += 1
        await _mirror_credentials(session, connection)
    await session.flush()
    return connection


async def validate_source_connection(
    session: AsyncSession, source: ExternalSource, connection: ProviderConnection
) -> None:
    """공유 키를 제공자와 무관한 원문 사이트로 보내지 않는다."""
    search = source.adapter_spec.get("search") or {}
    target = httpx.URL(str(search.get("url_template", source.base_url)))
    allowed = {
        "naver_hub": (
            "naverapihub.apigw.ntruss.com",
            {"/search/v1/blog", "/search/v1/webkr", "/search/v1/cafearticle"},
        ),
        "naver_legacy": (
            "openapi.naver.com",
            {"/v1/search/blog.json", "/v1/search/webkr.json", "/v1/search/cafearticle.json"},
        ),
        "brave": ("api.search.brave.com", {"/res/v1/web/search"}),
    }
    if connection.provider_kind in {"openai_ocr", "exa"}:
        raise ValidationFailedError("이 연결은 제공자의 전용 기능에서 사용합니다")
    if connection.provider_kind in allowed:
        host, paths = allowed[connection.provider_kind]
        if target.scheme != "https" or target.host != host or target.path not in paths:
            raise ValidationFailedError("제공자 인증 정보를 다른 주소로 전달할 수 없습니다")
    if connection.provider_kind == "source" and connection.origin_id is not None:
        original = await session.get(ExternalSource, connection.origin_id)
        if original is None or original.user_id != connection.user_id:
            raise ValidationFailedError("기존 인증 대상 소스를 확인할 수 없습니다")
        original_search = original.adapter_spec.get("search") or {}
        original_url = httpx.URL(str(original_search.get("url_template", original.base_url)))
        if target.host != original_url.host:
            raise ValidationFailedError("서로 다른 사이트는 별도 인증 연결로 등록하세요")


async def source_configuration_changed(session: AsyncSession, source: ExternalSource) -> None:
    if source.connection_id is None:
        return
    connection = await session.get(ProviderConnection, source.connection_id)
    if connection is None or connection.deleted_at is not None:
        return
    await validate_source_connection(session, source, connection)
    connection.config_revision += 1
    if connection.provider_kind == "source" and connection.origin_id == source.id:
        connection.required_fields = _required_source_fields(source)
    await _invalidate_sources(session, connection, exclude_source_id=source.id)
    await session.flush()


async def get_request_credentials(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    connection_id: uuid.UUID,
    master_key: str,
    require_active: bool = True,
) -> dict[str, str]:
    """서버 송신용으로만 사용한다. 반환값을 API·캐시·로그에 넣지 않는다."""
    connection = await get_owned_connection(session, user_id=user_id, connection_id=connection_id)
    if require_active and not connection.is_active:
        raise ConnectionChanged("연결 사용이 일시 중지되었습니다")
    rows = await _credential_rows(session, connection)
    if set(connection.required_fields) - {row.name for row in rows}:
        raise ValueError("필수 인증 항목이 누락되었습니다")
    return {row.name: decrypt_secret(row.secret_ciphertext, master_key=master_key) for row in rows}


async def reserve_connection_request(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    connection_id: uuid.UUID,
    expected_revision: int,
    require_active: bool = True,
    source_id: uuid.UUID | None = None,
    source_revision: int | None = None,
) -> None:
    """모든 실제 송신 직전에 최신 상태를 확인하고 source/connection을 함께 예약한다."""
    row = (
        await session.execute(
            select(
                ProviderConnection.config_revision,
                ProviderConnection.is_active,
                ProviderConnection.rate_limit_per_min,
                ProviderConnection.request_limit_per_day,
            ).where(
                ProviderConnection.id == connection_id,
                ProviderConnection.user_id == user_id,
                ProviderConnection.deleted_at.is_(None),
            )
        )
    ).first()
    if row is None or row[0] != expected_revision or (require_active and not row[1]):
        raise ConnectionChanged("요청 중 연결 설정이 바뀌었습니다")
    budgets = [RequestBudget("connection", connection_id, row[2], row[3])]
    if source_id is not None:
        source = (
            await session.execute(
                select(
                    ExternalSource.config_revision,
                    ExternalSource.is_active,
                    ExternalSource.rate_limit_per_min,
                    ExternalSource.request_limit_per_day,
                    ExternalSource.connection_id,
                ).where(
                    ExternalSource.id == source_id,
                    ExternalSource.user_id == user_id,
                    ExternalSource.deleted_at.is_(None),
                )
            )
        ).first()
        if (
            source is None
            or source[4] != connection_id
            or (source_revision is not None and source[0] != source_revision)
            or (require_active and not source[1])
        ):
            raise ConnectionChanged("요청 중 소스 설정이 바뀌었습니다")
        budgets.append(RequestBudget("source", source_id, source[2], source[3]))
    await reserve_request(user_id=user_id, budgets=budgets)


async def probe_connection(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    connection_id: uuid.UUID,
    expected_revision: int,
    master_key: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ConnectionProbe:
    connection = await get_owned_connection(session, user_id=user_id, connection_id=connection_id)
    await _check_expected(connection, expected_revision)
    try:
        credentials = await get_request_credentials(
            session,
            user_id=user_id,
            connection_id=connection_id,
            master_key=master_key,
            require_active=False,
        )
        if connection.provider_kind == "source" or connection.origin_kind == "source":
            from sooljang.application.external_sources import probe_source

            source = await session.scalar(
                select(ExternalSource)
                .where(
                    ExternalSource.connection_id == connection_id,
                    ExternalSource.user_id == user_id,
                    ExternalSource.deleted_at.is_(None),
                )
                .order_by(ExternalSource.id)
                .limit(1)
            )
            if source is None:
                outcome = SourceOutcome.INVALID_CONFIGURATION
            else:
                result = await probe_source(
                    session,
                    source=source,
                    sample_name="위스키",
                    master_key=master_key,
                    transport=transport,
                )
                outcome = result.outcome
        else:

            async def before_request(_request: httpx.Request) -> None:
                await reserve_connection_request(
                    session,
                    user_id=user_id,
                    connection_id=connection_id,
                    expected_revision=expected_revision,
                    require_active=False,
                )

            outcome = await test_provider_connection(
                connection.provider_kind,
                credentials,
                before_request=before_request,
                transport=transport,
            )
    except InvalidToken, ValueError:
        outcome = SourceOutcome.CREDENTIAL_UNAVAILABLE
    except RequestBudgetExceeded:
        outcome = SourceOutcome.RATE_LIMITED
    except ConnectionChanged:
        outcome = SourceOutcome.INVALID_CONFIGURATION
    result = await session.execute(
        update(ProviderConnection)
        .where(
            ProviderConnection.id == connection_id,
            ProviderConnection.user_id == user_id,
            ProviderConnection.config_revision == expected_revision,
            ProviderConnection.deleted_at.is_(None),
        )
        .values(
            verified_revision=expected_revision,
            last_test_at=datetime.now(UTC),
            last_outcome=outcome.value,
        )
        .returning(ProviderConnection.id)
        .execution_options(synchronize_session=False)
    )
    return ConnectionProbe(outcome, expected_revision, result.first() is not None)


async def connection_view(session: AsyncSession, connection: ProviderConnection) -> dict[str, Any]:
    """등록 메타데이터는 키를 복호화하지 않는다. 복구 필요는 실제 해독 실패 결과로 판정한다."""
    await session.flush()
    await session.refresh(connection, ["updated_at"])
    credentials = await _credential_rows(session, connection)
    missing = sorted(set(connection.required_fields) - {row.name for row in credentials})
    if not connection.required_fields:
        registration = "not_required"
    elif not credentials:
        registration = "unregistered"
    elif missing:
        registration = "incomplete"
    elif (
        connection.last_outcome == SourceOutcome.CREDENTIAL_UNAVAILABLE
        and connection.verified_revision == connection.config_revision
    ):
        registration = "recovery_required"
    else:
        registration = "saved"
    sources = list(
        await session.scalars(
            select(ExternalSource)
            .where(
                ExternalSource.connection_id == connection.id,
                ExternalSource.user_id == connection.user_id,
                ExternalSource.deleted_at.is_(None),
            )
            .order_by(ExternalSource.name)
        )
    )
    setting = await session.scalar(
        select(LlmSetting)
        .where(
            LlmSetting.connection_id == connection.id,
            LlmSetting.user_id == connection.user_id,
        )
        .order_by(LlmSetting.created_at.desc())
        .limit(1)
    )
    definition = provider_definition(connection.provider_kind)
    labels = {field.name: field.label for field in definition.fields}
    names = list(dict.fromkeys([*connection.required_fields, *(row.name for row in credentials)]))
    return {
        "id": connection.id,
        "provider_kind": connection.provider_kind,
        "name": connection.name,
        "is_active": connection.is_active,
        "config_revision": connection.config_revision,
        "rate_limit_per_min": connection.rate_limit_per_min,
        "request_limit_per_day": connection.request_limit_per_day,
        "registration": registration,
        "missing_fields": missing,
        "credential_fields": [
            {
                "name": name,
                "label": labels.get(name, name),
                "saved": any(row.name == name for row in credentials),
                "masked_hint": next(
                    (
                        f"...{row.hint}" if row.hint else "저장됨"
                        for row in credentials
                        if row.name == name
                    ),
                    None,
                ),
            }
            for name in names
        ],
        "origin_kind": connection.origin_kind,
        "updated_at": connection.updated_at,
        "verified_revision": connection.verified_revision,
        "last_test_at": connection.last_test_at,
        "last_outcome": connection.last_outcome,
        "verification_stale": connection.verified_revision is not None
        and connection.verified_revision != connection.config_revision,
        "features": list(definition.features),
        "sources": [
            {"id": source.id, "name": source.name, "is_active": source.is_active}
            for source in sources
        ],
        "usage": await current_usage(
            session, user_id=connection.user_id, scope_kind="connection", scope_id=connection.id
        ),
        "provider_remaining": None,
        "ocr_model": setting.model if setting is not None else DEFAULT_OPENAI_MODEL,
        "ocr_rematch_enabled": setting.rematch_enabled if setting is not None else False,
        "ocr_rematch_monthly_cap": setting.rematch_monthly_cap
        if setting is not None
        else DEFAULT_REMATCH_MONTHLY_CAP,
    }
