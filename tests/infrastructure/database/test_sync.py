"""동기화 애플리케이션 계층 검증 (`application/sync.py`).

`tests/api/test_sync.py` 가 HTTP 전 구간(인증·라우팅 포함)을 이미 검증했으므로, 여기는
API 층을 거치지 않고는 보기 어려운 것만 다룬다: 사용자 스코프 격리, 커서 페이지네이션
잘림 로직, SAVEPOINT 격리(실패한 작업 이전 것은 커밋 유지).
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.sync import SyncOperation, apply_batch, pull_changes
from sooljang.infrastructure.database.models import Vendor

pytestmark = pytest.mark.requires_db


async def _create_vendor(session: AsyncSession, *, user_id: uuid.UUID, name: str) -> uuid.UUID:
    vendor = Vendor(user_id=user_id, name=name)
    session.add(vendor)
    await session.flush()
    return vendor.id


def _create_op(*, entity: str, entity_id: uuid.UUID, fields: dict) -> SyncOperation:
    return SyncOperation(
        idempotency_key=uuid.uuid4(), entity=entity, op="create", entity_id=entity_id, fields=fields
    )


async def test_pull_scopes_by_user(
    session: AsyncSession, user_id: uuid.UUID, other_user_id: uuid.UUID
) -> None:
    await _create_vendor(session, user_id=user_id, name="내 구매처")
    await _create_vendor(session, user_id=other_user_id, name="남의 구매처")

    mine = await pull_changes(session, user_id=user_id, cursor=None)
    theirs = await pull_changes(session, user_id=other_user_id, cursor=None)

    assert [row["name"] for row in mine.changes["vendor"]] == ["내 구매처"]
    assert [row["name"] for row in theirs.changes["vendor"]] == ["남의 구매처"]


async def test_pull_includes_soft_deleted_rows(session: AsyncSession, user_id: uuid.UUID) -> None:
    vendor_id = await _create_vendor(session, user_id=user_id, name="삭제 예정")
    vendor = await session.get(Vendor, vendor_id)
    assert vendor is not None
    vendor.deleted_at = datetime.now(UTC)
    await session.flush()

    result = await pull_changes(session, user_id=user_id, cursor=None)
    row = next(r for r in result.changes["vendor"] if r["id"] == str(vendor_id))
    assert row["deleted_at"] is not None


async def test_pull_pagination_truncates_and_sets_has_more(
    session: AsyncSession, user_id: uuid.UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sooljang.application.sync as sync_module

    monkeypatch.setattr(sync_module, "SYNC_PAGE_LIMIT", 2)

    for i in range(3):
        await _create_vendor(session, user_id=user_id, name=f"구매처{i}")

    first = await pull_changes(session, user_id=user_id, cursor=None)
    assert len(first.changes["vendor"]) == 2
    assert first.has_more is True
    assert first.next_cursor is not None

    from sooljang.api.pagination import Cursor

    second = await pull_changes(session, user_id=user_id, cursor=Cursor.decode(first.next_cursor))
    assert len(second.changes["vendor"]) == 1
    assert second.has_more is False

    seen_names = {row["name"] for row in first.changes["vendor"] + second.changes["vendor"]}
    assert seen_names == {"구매처0", "구매처1", "구매처2"}


async def test_apply_batch_savepoint_isolation(session: AsyncSession, user_id: uuid.UUID) -> None:
    """실패한 작업 이전의 작업은 커밋된 채로 남아야 한다(head-of-line blocking)."""
    good_id = uuid.uuid4()
    result = await apply_batch(
        session,
        user_id=user_id,
        operations=[
            _create_op(entity="vendor", entity_id=good_id, fields={"name": "정상 생성"}),
            _create_op(
                entity="purchase", entity_id=uuid.uuid4(), fields={"sku_id": str(uuid.uuid4())}
            ),
            _create_op(entity="vendor", entity_id=uuid.uuid4(), fields={"name": "실행 안 됨"}),
        ],
    )

    assert result.stopped is True
    assert [r.status for r in result.results] == ["applied", "failed"]

    vendor = await session.get(Vendor, good_id)
    assert vendor is not None
    assert vendor.name == "정상 생성"
