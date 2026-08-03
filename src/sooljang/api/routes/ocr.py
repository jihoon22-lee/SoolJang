"""라벨 OCR 라우터(Task 17).

`POST /ocr/label` 은 아무것도 저장하지 않는다 — Vision LLM 이 뽑은 필드를 신뢰도와 함께
돌려줄 뿐이다. 사용자가 화면에서 검수·수정한 뒤 평소처럼 `POST /products` 로 저장하고,
원본 사진은 그때 `POST /attachments` 로 따로 올린다(`docs/plan.md` Task 17 "원본·결과
보관" — 사진과 저장된 제품 자체가 각각 원본과 결과다).
"""

from typing import Annotated

from fastapi import APIRouter, File, UploadFile, status

from sooljang.api.deps import SessionDep, SettingsDep, UserDep
from sooljang.api.errors import LlmNotConfiguredError, ValidationFailedError
from sooljang.api.schemas.ocr import LabelExtractionOut
from sooljang.application.llm_settings import get_decrypted_api_key
from sooljang.infrastructure.external import llm
from sooljang.infrastructure.storage import (
    ALLOWED_IMAGE_EXTENSIONS,
    UploadTooLargeError,
    read_upload_within_limit,
    sniff_image_extension,
)

router = APIRouter(prefix="/ocr", tags=["ocr"])

#: 업로드 크기 상한. `api/routes/attachments.py` 와 같은 값을 쓴다.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@router.post("/label", response_model=LabelExtractionOut, status_code=status.HTTP_200_OK)
async def extract_label_fields(
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File(description="라벨 사진")],
) -> LabelExtractionOut:
    """라벨 사진에서 이름·생산자·도수 등을 추출한다. 실패하면 수동 입력으로 폴백한다."""
    extension = ALLOWED_IMAGE_EXTENSIONS.get(file.content_type or "")
    if extension is None:
        raise ValidationFailedError(
            f"지원하지 않는 파일 형식입니다: {file.content_type!r}. "
            f"허용: {', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}"
        )

    try:
        data = await read_upload_within_limit(file, max_bytes=MAX_UPLOAD_BYTES)
    except UploadTooLargeError as error:
        raise ValidationFailedError(
            f"파일이 너무 큽니다. 상한은 {MAX_UPLOAD_BYTES:,} bytes 입니다"
        ) from error
    if not data:
        raise ValidationFailedError("빈 파일입니다")
    if sniff_image_extension(data) != extension:
        raise ValidationFailedError(
            f"파일 내용이 선언한 형식({file.content_type})과 일치하지 않습니다"
        )

    configured = await get_decrypted_api_key(
        session, user_id=user_id, master_key=settings.secret_key
    )
    if configured is None:
        raise LlmNotConfiguredError("라벨 OCR 을 쓰려면 먼저 설정 화면에서 LLM API 키를 등록하세요")
    _provider, api_key, model = configured

    try:
        extraction = await llm.extract_label(
            data, api_key=api_key, model=model, content_type=file.content_type or "image/jpeg"
        )
    except llm.LabelExtractionFailedError as error:
        raise ValidationFailedError(
            f"라벨 인식에 실패했습니다. 다시 시도하거나 직접 입력하세요: {error}"
        ) from error

    return LabelExtractionOut.from_extraction(extraction)
