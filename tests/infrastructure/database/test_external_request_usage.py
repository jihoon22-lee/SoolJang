"""실제 PostgreSQL에서 병렬 요청·재시작·공유 연결의 한도를 검증한다."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncConnection, async_sessionmaker

from sooljang.application.external_request_usage import (
    RequestBudget,
    RequestBudgetExceeded,
    current_usage,
    reserve_request,
)
from sooljang.infrastructure.database.models import ExternalRequestUsage


async def test_concurrent_callers_and_new_factories_share_the_same_limit(
    connection: AsyncConnection, user_id: uuid.UUID
) -> None:
    scope = RequestBudget("source", uuid.uuid4(), per_minute=3, per_day=10)
    factory = async_sessionmaker(connection.engine, expire_on_commit=False)
    now = datetime.now(UTC)
    results = await asyncio.gather(
        *(
            reserve_request(user_id=user_id, budgets=[scope], now=now, factory=factory)
            for _ in range(12)
        ),
        return_exceptions=True,
    )
    assert results.count(None) == 3
    assert sum(isinstance(result, RequestBudgetExceeded) for result in results) == 9
    restarted = async_sessionmaker(connection.engine, expire_on_commit=False)
    with pytest.raises(RequestBudgetExceeded):
        await reserve_request(user_id=user_id, budgets=[scope], now=now, factory=restarted)
    async with restarted() as session:
        counts = await session.scalars(select(ExternalRequestUsage.reserved_count))
        assert list(counts) == [3, 3]
        usage = await current_usage(
            session, user_id=user_id, scope_kind="source", scope_id=scope.scope_id
        )
        assert usage["day"] == 3


async def test_shared_connection_limit_rolls_back_source_reservation(
    connection: AsyncConnection, user_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(connection.engine, expire_on_commit=False)
    first = RequestBudget("source", uuid.uuid4(), 10, 10)
    second = RequestBudget("source", uuid.uuid4(), 10, 10)
    shared = RequestBudget("connection", uuid.uuid4(), 1, 10)
    now = datetime.now(UTC)
    await reserve_request(user_id=user_id, budgets=[first, shared], now=now, factory=factory)
    with pytest.raises(RequestBudgetExceeded):
        await reserve_request(user_id=user_id, budgets=[second, shared], now=now, factory=factory)
    async with factory() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(ExternalRequestUsage)
                .where(ExternalRequestUsage.scope_id == second.scope_id)
            )
            == 0
        )
    await reserve_request(user_id=uuid.uuid4(), budgets=[second, shared], now=now, factory=factory)


async def test_daily_limit_survives_minute_boundary_and_unrelated_rollback(
    connection: AsyncConnection, user_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(connection.engine, expire_on_commit=False)
    scope = RequestBudget("source", uuid.uuid4(), 1, 2)
    now = datetime(2026, 9, 7, 3, 0, tzinfo=UTC)
    for delta in (timedelta(), timedelta(minutes=1)):
        await reserve_request(user_id=user_id, budgets=[scope], now=now + delta, factory=factory)
    # 조회 유스케이스의 별도 트랜잭션을 롤백해도 이미 커밋한 예약은 남는다.
    async with factory() as unrelated:
        await unrelated.execute(select(ExternalRequestUsage))
        await unrelated.rollback()
    with pytest.raises(RequestBudgetExceeded):
        await reserve_request(
            user_id=user_id, budgets=[scope], now=now + timedelta(minutes=2), factory=factory
        )
    await reserve_request(
        user_id=user_id, budgets=[scope], now=now + timedelta(days=1), factory=factory
    )


async def test_empty_and_duplicate_budget_scopes_are_rejected(user_id: uuid.UUID) -> None:
    scope = RequestBudget("source", uuid.uuid4(), 1)
    for budgets in ([], [scope, scope]):
        with pytest.raises(ValueError):
            await reserve_request(user_id=user_id, budgets=budgets)
    with pytest.raises(ValueError):
        await reserve_request(user_id=user_id, budgets=[scope], now=datetime(2026, 9, 7))


@pytest.mark.parametrize("kind,limit", [("invalid", 1), ("source", 0), ("connection", -1)])
def test_invalid_request_budgets_are_rejected(kind: str, limit: int) -> None:
    with pytest.raises(ValueError):
        RequestBudget(kind, uuid.uuid4(), limit)
