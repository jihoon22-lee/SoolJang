"""LLM 설정 저장·조회(Task 17).

API 키는 절대 평문으로 왕복하지 않는다 — 저장 시 암호화하고, 조회 응답에는 뒤 4자리만
남긴 마스킹 문자열을 보여준다. 원문은 라벨 OCR 호출 직전에만 복호화해 쓰고, 그 반환값을
API 응답 스키마에 담지 않는다.

사용자당 활성 설정은 최대 1개다. DB 유니크 제약으로 강제하지 않는 이유는
`models/llm.py::LlmSetting` 문서에 있다 — soft delete 후 재저장과 충돌하기 때문이다.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError
from sooljang.infrastructure.database.models import (
    DEFAULT_REMATCH_MONTHLY_CAP,
    LlmProvider,
    LlmSetting,
    ProviderConnection,
)
from sooljang.infrastructure.security.secrets import InvalidToken, decrypt_secret, encrypt_secret

#: 마스킹 시 보여줄 꼬리 글자 수. 키가 맞는지 눈으로 확인할 정도만 노출한다.
_VISIBLE_SUFFIX = 4


def hint_of(plaintext: str) -> str:
    """DB 에 평문으로 남길 마지막 4자. `LlmSetting.api_key_hint` 에 저장한다."""
    return plaintext[-_VISIBLE_SUFFIX:]


def mask_api_key(hint: str) -> str:
    """저장된 힌트를 화면에 보여줄 형태로 바꾼다. 예: `ab12` → `...ab12`."""
    return f"...{hint}"


async def get_llm_setting(session: AsyncSession, *, user_id: uuid.UUID) -> LlmSetting | None:
    """활성 설정 하나. 여러 행이 남아 있어도(경쟁 상황) 가장 최근 것을 쓴다."""
    return await session.scalar(
        select(LlmSetting)
        .outerjoin(ProviderConnection, LlmSetting.connection_id == ProviderConnection.id)
        .where(LlmSetting.user_id == user_id, LlmSetting.deleted_at.is_(None))
        .order_by(
            case((ProviderConnection.is_active.is_(True), 1), else_=0).desc(),
            LlmSetting.created_at.desc(),
        )
        .limit(1)
    )


async def save_llm_setting(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    provider: LlmProvider,
    api_key: str,
    model: str,
    master_key: str,
    rematch_enabled: bool = False,
    rematch_monthly_cap: int = DEFAULT_REMATCH_MONTHLY_CAP,
) -> LlmSetting:
    """설정을 저장한다. 기존 활성 행이 있으면 갱신하고, 없으면 새로 만든다.

    `rematch_enabled`(Task 34 PR6, "LLM 매칭 보조" 토글)는 기본값이 반드시 꺼짐이다 —
    라벨 OCR 을 위해 키를 등록한 사용자에게 조회 때마다 추가 LLM 호출이 조용히 시작되면
    안 된다는 계획서 요구 때문이다.
    """
    ciphertext = encrypt_secret(api_key, master_key=master_key)
    hint = hint_of(api_key)
    existing = await get_llm_setting(session, user_id=user_id)
    if existing is not None:
        existing.provider = provider
        existing.api_key_ciphertext = ciphertext
        existing.api_key_hint = hint
        existing.model = model
        existing.rematch_enabled = rematch_enabled
        existing.rematch_monthly_cap = rematch_monthly_cap
        from sooljang.application.provider_connections import sync_legacy_llm_setting

        await sync_legacy_llm_setting(session, existing)
        return existing

    created = LlmSetting(
        user_id=user_id,
        provider=provider,
        api_key_ciphertext=ciphertext,
        api_key_hint=hint,
        model=model,
        rematch_enabled=rematch_enabled,
        rematch_monthly_cap=rematch_monthly_cap,
    )
    session.add(created)
    await session.flush()
    from sooljang.application.provider_connections import sync_legacy_llm_setting

    await sync_legacy_llm_setting(session, created)
    return created


async def clear_llm_setting(session: AsyncSession, *, user_id: uuid.UUID) -> bool:
    """설정을 지운다(soft delete). 지울 설정이 없으면 `False`."""
    existing = await get_llm_setting(session, user_id=user_id)
    if existing is None:
        return False
    if existing.connection_id is not None:
        from sooljang.application.provider_connections import (
            get_owned_connection,
            remove_connection,
        )

        connection = await get_owned_connection(
            session, user_id=user_id, connection_id=existing.connection_id
        )
        await remove_connection(
            session,
            user_id=user_id,
            connection_id=connection.id,
            expected_revision=connection.config_revision,
        )
    existing.deleted_at = datetime.now(UTC)
    return True


async def get_decrypted_api_key(
    session: AsyncSession, *, user_id: uuid.UUID, master_key: str, reserve: bool = False
) -> tuple[LlmProvider, str, str] | None:
    """(제공자, 복호화된 키, 모델). 설정이 없으면 `None`.

    OCR 호출 직전에만 쓴다 — 반환값을 API 응답 스키마에 절대 담지 않는다.
    """
    setting = await get_llm_setting(session, user_id=user_id)
    if setting is None:
        return None
    if setting.connection_id is not None:
        from sooljang.application.provider_connections import (
            ConnectionChanged,
            get_owned_connection,
            get_request_credentials,
            reserve_connection_request,
        )

        try:
            values = await get_request_credentials(
                session, user_id=user_id, connection_id=setting.connection_id, master_key=master_key
            )
        except ConnectionChanged, ValueError:
            return None
        except InvalidToken:
            raise ConflictError(
                "저장된 API 키를 복호화할 수 없습니다. API·외부 연결에서 복구 키를 확인하세요"
            ) from None
        api_key = values.get("api_key")
        if api_key is None:
            return None
        if reserve:
            from sooljang.application.provider_connections import ConnectionLimitError
            from sooljang.domain.discovery import RequestBudgetExceeded

            connection = await get_owned_connection(
                session, user_id=user_id, connection_id=setting.connection_id
            )
            try:
                await reserve_connection_request(
                    session,
                    user_id=user_id,
                    connection_id=connection.id,
                    expected_revision=connection.config_revision,
                )
            except RequestBudgetExceeded:
                raise ConnectionLimitError("이 연결의 요청 상한에 도달했습니다") from None
    else:
        api_key = decrypt_secret(setting.api_key_ciphertext, master_key=master_key)
    return setting.provider, api_key, setting.model
