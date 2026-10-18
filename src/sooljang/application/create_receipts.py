"""온라인 생성 요청(`POST /products`, `POST /purchases`)의 멱등 영수증.

응답을 잃은 재전송이 같은 행을 돌려받아야 하지만, 같은 `request_id`로 내용이 다른 요청은
거부해야 한다. 만든 행은 나중에 수정되므로 행의 현재 값과 비교하면 수정 뒤의 재전송을 잘못
판정한다. 처음 요청 내용의 지문을 `outbox_receipt`에 따로 남겨 그것과 비교한다.
"""

import datetime
import hashlib
import json
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import ConflictError
from sooljang.infrastructure.database.models import OutboxReceipt


def _canonical(value: Any) -> Any:
    """같은 뜻의 값이 같은 문자열이 되게 한다(`46.0`과 `46`, UUID·날짜 표기)."""
    if isinstance(value, Decimal):
        return format(value.normalize(), "f")
    if isinstance(value, uuid.UUID | datetime.date):
        return str(value)
    if isinstance(value, dict):
        return {key: _canonical(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_canonical(item) for item in value]
    return value


def request_fingerprint(request: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(_canonical(request), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _receipt_id(user_id: uuid.UUID, kind: str, request_id: uuid.UUID) -> uuid.UUID:
    # outbox 멱등 키와 섞이지 않게 사용자·종류별 이름 공간에서 만든다.
    return uuid.uuid5(user_id, f"{kind}-create-receipt:{request_id}")


async def ensure_same_request(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    kind: str,
    request_id: uuid.UUID,
    fingerprint: str,
) -> None:
    """이미 만든 행의 재전송이면 통과하고, 처음 요청과 내용이 다르면 409로 거부한다."""
    receipt = await session.get(OutboxReceipt, _receipt_id(user_id, kind, request_id))
    if receipt is None or receipt.user_id != user_id:
        raise ConflictError("같은 요청 식별자로 이미 다른 기록을 만들었습니다")
    if receipt.response_snapshot.get("receipt_expired"):
        raise ConflictError("요청 재시도 보관 기간이 지났습니다. 최신 기록을 확인하세요")
    if receipt.response_snapshot.get("_request_hash") != fingerprint:
        raise ConflictError("같은 요청 식별자로 다른 내용을 등록할 수 없습니다")


def save_request(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    kind: str,
    request_id: uuid.UUID,
    entity_id: uuid.UUID,
    fingerprint: str,
) -> None:
    session.add(
        OutboxReceipt(
            id=_receipt_id(user_id, kind, request_id),
            user_id=user_id,
            entity=kind,
            operation="create_request",
            entity_id=entity_id,
            status="applied",
            response_snapshot={"_request_hash": fingerprint},
        )
    )
