"""LLM 설정 라우터(Task 17).

라벨 OCR(`POST /ocr/label`)이 쓸 Vision LLM 제공자·API 키·모델을 이 화면에서 관리한다.
`.env` 를 직접 고치지 않고 로그인 후 앱 안에서 설정할 수 있어야 한다는 요구에 따른
설계다 — 유일한 예외는 DB 에 저장하는 시크릿을 암호화할 마스터 키(`SOOLJANG_SECRET_KEY`)
뿐이며, 이건 배포 시 한 번만 넣으면 된다.
"""

from fastapi import APIRouter, status

from sooljang.api.deps import SessionDep, SettingsDep, UserDep
from sooljang.api.schemas.llm_settings import LlmSettingIn, LlmSettingOut
from sooljang.application.llm_settings import (
    clear_llm_setting,
    get_llm_setting,
    mask_api_key,
    save_llm_setting,
)

router = APIRouter(prefix="/llm-settings", tags=["llm-settings"])


@router.get("", response_model=LlmSettingOut)
async def read_llm_setting(session: SessionDep, user_id: UserDep) -> LlmSettingOut:
    """현재 설정 상태. API 키 원문은 절대 내려주지 않는다 — 마스킹된 값만 준다."""
    setting = await get_llm_setting(session, user_id=user_id)
    if setting is None:
        return LlmSettingOut(configured=False)
    return LlmSettingOut(
        configured=True,
        provider=setting.provider,
        model=setting.model,
        api_key_masked=mask_api_key(setting.api_key_hint),
        updated_at=setting.updated_at,
    )


@router.put("", response_model=LlmSettingOut, status_code=status.HTTP_200_OK)
async def upsert_llm_setting(
    payload: LlmSettingIn, session: SessionDep, user_id: UserDep, settings: SettingsDep
) -> LlmSettingOut:
    """설정을 저장한다. 이미 있으면 덮어쓴다."""
    setting = await save_llm_setting(
        session,
        user_id=user_id,
        provider=payload.provider,
        api_key=payload.api_key,
        model=payload.model,
        master_key=settings.secret_key,
    )
    return LlmSettingOut(
        configured=True,
        provider=setting.provider,
        model=setting.model,
        api_key_masked=mask_api_key(setting.api_key_hint),
        updated_at=setting.updated_at,
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def remove_llm_setting(session: SessionDep, user_id: UserDep) -> None:
    """설정을 지운다. 이후 라벨 OCR 요청은 설정이 필요하다는 오류를 받는다."""
    await clear_llm_setting(session, user_id=user_id)
