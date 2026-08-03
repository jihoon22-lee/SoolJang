"""첨부파일 업로드 라우터.

`docs/architecture.md` 가 Task 10 산출물로 문서화했지만 실제로는 구현되지 않았던
엔드포인트다(Task 16 이 `PATCH /skus/{id}` 갭을 채운 것과 같은 종류의 문서-코드 드리프트).
Task 17(라벨 OCR)이 "원본 보관"을 만족하려면 필요해 여기서 채운다.

지금은 이미지만 받는다(`infrastructure/storage.py::ALLOWED_IMAGE_EXTENSIONS`) — 라벨·
시음·병 사진이 유일한 실사용처다. 임의 파일 형식을 허용하면 검증 범위가 불필요하게 넓어진다.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.deps import SessionDep, SettingsDep, UserDep
from sooljang.api.errors import NotFoundError, ValidationFailedError
from sooljang.api.schemas.attachments import AttachmentOut
from sooljang.application.products import load_product
from sooljang.infrastructure.database.models import (
    Attachment,
    AttachmentKind,
    Bottle,
    TastingSession,
)
from sooljang.infrastructure.storage import ALLOWED_IMAGE_EXTENSIONS, compute_sha256, save_upload

router = APIRouter(prefix="/attachments", tags=["attachments"])

#: 업로드 크기 상한. 휴대폰 카메라 사진은 대개 수 MB 다.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


async def _ensure_owner_exists(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    product_id: uuid.UUID | None,
    bottle_id: uuid.UUID | None,
    tasting_session_id: uuid.UUID | None,
) -> None:
    """대상이 이 사용자 소유로 실제 존재하는지 확인한다. 남의 레코드에 첨부를 못 붙이게 한다."""
    if product_id is not None:
        await load_product(session, user_id=user_id, product_id=product_id)
        return
    if bottle_id is not None:
        found = await session.scalar(
            select(Bottle.id).where(
                Bottle.id == bottle_id, Bottle.user_id == user_id, Bottle.deleted_at.is_(None)
            )
        )
        if found is None:
            raise NotFoundError(f"병을 찾을 수 없습니다: {bottle_id}")
        return
    found = await session.scalar(
        select(TastingSession.id).where(
            TastingSession.id == tasting_session_id,
            TastingSession.user_id == user_id,
            TastingSession.deleted_at.is_(None),
        )
    )
    if found is None:
        raise NotFoundError(f"시음 기록을 찾을 수 없습니다: {tasting_session_id}")


@router.post("", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_attachment(
    session: SessionDep,
    user_id: UserDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File(description="라벨·시음·병 사진")],
    kind: Annotated[AttachmentKind, Form()],
    product_id: Annotated[uuid.UUID | None, Form()] = None,
    bottle_id: Annotated[uuid.UUID | None, Form()] = None,
    tasting_session_id: Annotated[uuid.UUID | None, Form()] = None,
    caption: Annotated[str | None, Form()] = None,
) -> Attachment:
    """첨부를 업로드한다.

    `product_id`·`bottle_id`·`tasting_session_id` 중 정확히 하나가 필요하다.
    """
    owners = (product_id, bottle_id, tasting_session_id)
    if sum(owner is not None for owner in owners) != 1:
        raise ValidationFailedError(
            "product_id·bottle_id·tasting_session_id 중 정확히 하나를 지정하세요"
        )
    await _ensure_owner_exists(
        session,
        user_id=user_id,
        product_id=product_id,
        bottle_id=bottle_id,
        tasting_session_id=tasting_session_id,
    )

    extension = ALLOWED_IMAGE_EXTENSIONS.get(file.content_type or "")
    if extension is None:
        raise ValidationFailedError(
            f"지원하지 않는 파일 형식입니다: {file.content_type!r}. "
            f"허용: {', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}"
        )

    data = await file.read()
    if not data:
        raise ValidationFailedError("빈 파일입니다")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValidationFailedError(
            f"파일이 너무 큽니다 ({len(data):,} bytes). 상한은 {MAX_UPLOAD_BYTES:,} bytes 입니다"
        )

    sha256 = compute_sha256(data)

    # 소유 대상(product_id/bottle_id/tasting_session_id)까지 같아야 "같은 업로드" 다 —
    # 대상을 빼면 라벨 사진 하나를 다른 제품에 붙일 때 앞서 만든 첨부가 그대로 반환돼
    # 새로 등록하는 제품엔 첨부가 안 붙는다(요청은 201 로 성공하는데 실제로는 조용히
    # 실패하는 셈이다). soft delete 된 행도 부활시키면 안 되니 `deleted_at IS NULL` 도
    # 확인한다. 셋 중 정확히 하나만 채워지므로(위 검증) 나머지 둘은 양쪽 다 `NULL` 이라
    # `==` 비교가 SQLAlchemy 에서 자동으로 `IS NULL` 로 바뀐다.
    existing = await session.scalar(
        select(Attachment).where(
            Attachment.user_id == user_id,
            Attachment.sha256 == sha256,
            Attachment.kind == kind,
            Attachment.product_id == product_id,
            Attachment.bottle_id == bottle_id,
            Attachment.tasting_session_id == tasting_session_id,
            Attachment.deleted_at.is_(None),
        )
    )
    if existing is not None:
        # 같은 파일을 같은 대상에 다시 올린 것 — 새로 만들지 않고 기존 걸 그대로
        # 돌려준다. 폰에서 같은 사진을 다시 고르는 일이 흔하다
        # (`models/tasting.py::Attachment` 문서 참조).
        return existing

    storage_path = save_upload(
        settings.upload_dir, user_id=user_id, sha256=sha256, extension=extension, data=data
    )

    attachment = Attachment(
        user_id=user_id,
        kind=kind,
        storage_path=storage_path,
        original_filename=file.filename,
        content_type=file.content_type or "application/octet-stream",
        byte_size=len(data),
        sha256=sha256,
        caption=caption,
        product_id=product_id,
        bottle_id=bottle_id,
        tasting_session_id=tasting_session_id,
    )
    session.add(attachment)
    await session.flush()
    return attachment
