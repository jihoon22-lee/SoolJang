"""LLM 설정 저장·조회(Task 17).

API 키는 절대 평문으로 왕복하지 않는다 — 저장 시 암호화하고, 조회 응답에는 뒤 4자리만
남긴 마스킹 문자열을 보여준다. 원문은 라벨 OCR 호출 직전에만 복호화해 쓰고, 그 반환값을
API 응답 스키마에 담지 않는다.

사용자당 활성 설정은 최대 1개다. DB 유니크 제약으로 강제하지 않는 이유는
`models/llm.py::LlmSetting` 문서에 있다 — soft delete 후 재저장과 충돌하기 때문이다.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import LlmProvider, LlmSetting
from sooljang.infrastructure.security.secrets import decrypt_secret, encrypt_secret

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
        .where(LlmSetting.user_id == user_id, LlmSetting.deleted_at.is_(None))
        .order_by(LlmSetting.created_at.desc())
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
) -> LlmSetting:
    """설정을 저장한다. 기존 활성 행이 있으면 갱신하고, 없으면 새로 만든다."""
    ciphertext = encrypt_secret(api_key, master_key=master_key)
    hint = hint_of(api_key)
    existing = await get_llm_setting(session, user_id=user_id)
    if existing is not None:
        existing.provider = provider
        existing.api_key_ciphertext = ciphertext
        existing.api_key_hint = hint
        existing.model = model
        return existing

    created = LlmSetting(
        user_id=user_id,
        provider=provider,
        api_key_ciphertext=ciphertext,
        api_key_hint=hint,
        model=model,
    )
    session.add(created)
    await session.flush()
    return created


async def clear_llm_setting(session: AsyncSession, *, user_id: uuid.UUID) -> bool:
    """설정을 지운다(soft delete). 지울 설정이 없으면 `False`."""
    existing = await get_llm_setting(session, user_id=user_id)
    if existing is None:
        return False
    existing.deleted_at = datetime.now(UTC)
    return True


async def get_decrypted_api_key(
    session: AsyncSession, *, user_id: uuid.UUID, master_key: str
) -> tuple[LlmProvider, str, str] | None:
    """(제공자, 복호화된 키, 모델). 설정이 없으면 `None`.

    OCR 호출 직전에만 쓴다 — 반환값을 API 응답 스키마에 절대 담지 않는다.
    """
    setting = await get_llm_setting(session, user_id=user_id)
    if setting is None:
        return None
    api_key = decrypt_secret(setting.api_key_ciphertext, master_key=master_key)
    return setting.provider, api_key, setting.model
