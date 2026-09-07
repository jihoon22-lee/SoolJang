"""소스/연결 공유 요청 예산을 원자적으로 예약한다.

카운터는 주 유스케이스 롤백과 무관하게 유지한다. 한 요청의 source/connection 예약은
같은 트랜잭션에서 처리하므로 한 범위가 한도를 넘으면 다른 예약도 되돌린다.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from sooljang.domain.discovery import RequestBudgetExceeded
from sooljang.infrastructure.database.models.external_usage import ExternalRequestUsage
from sooljang.infrastructure.database.session import get_session_factory

__all__ = ["RequestBudget", "RequestBudgetExceeded", "current_usage", "reserve_request"]


@dataclass(frozen=True, slots=True)
class RequestBudget:
    scope_kind: str
    scope_id: uuid.UUID
    per_minute: int
    per_day: int = 1000

    def __post_init__(self) -> None:
        if self.scope_kind not in {"source", "connection"}:
            raise ValueError("소스 또는 연결 범위를 지정해야 합니다")
        if self.per_minute < 1 or self.per_day < 1:
            raise ValueError("요청 한도는 양수여야 합니다")


async def reserve_request(
    *,
    user_id: uuid.UUID,
    budgets: Sequence[RequestBudget],
    now: datetime | None = None,
    factory: async_sessionmaker[AsyncSession] | None = None,
) -> None:
    """실제 HTTP 시도 직전 호출한다. redirect·robots·retry도 각각 1회 예약한다."""
    if not budgets:
        raise ValueError("요청 예산이 필요합니다")
    if len({(budget.scope_kind, budget.scope_id) for budget in budgets}) != len(budgets):
        raise ValueError("같은 요청 범위의 예산을 중복 지정할 수 없습니다")
    instant = now or datetime.now(UTC)
    if instant.tzinfo is None:
        raise ValueError("예약 시각에는 시간대가 필요합니다")
    instant = instant.astimezone(UTC)
    windows = {
        "minute": instant.replace(second=0, microsecond=0),
        "day": instant.replace(hour=0, minute=0, second=0, microsecond=0),
    }
    session_factory = factory or get_session_factory()
    # 잠금 순서를 고정해 여러 source가 같은 connection을 공유해도 교착을 피한다.
    ordered = sorted(budgets, key=lambda budget: (budget.scope_kind, str(budget.scope_id)))
    async with session_factory.begin() as session:
        for budget in ordered:
            for kind, limit in (("day", budget.per_day), ("minute", budget.per_minute)):
                stmt = insert(ExternalRequestUsage).values(
                    user_id=user_id,
                    scope_kind=budget.scope_kind,
                    scope_id=budget.scope_id,
                    window_kind=kind,
                    window_start=windows[kind],
                    reserved_count=1,
                )
                result = await session.scalar(
                    stmt.on_conflict_do_update(
                        index_elements=[
                            "user_id",
                            "scope_kind",
                            "scope_id",
                            "window_kind",
                            "window_start",
                        ],
                        set_={"reserved_count": ExternalRequestUsage.reserved_count + 1},
                        where=ExternalRequestUsage.reserved_count < limit,
                    ).returning(ExternalRequestUsage.reserved_count)
                )
                if result is None:
                    raise RequestBudgetExceeded("외부 요청 한도에 도달했습니다")
                if kind == "day" and result == 1:
                    # 일별 첫 예약에서만 오래된 집계를 정리한다. 요청 원문/비밀은 없다.
                    await session.execute(
                        delete(ExternalRequestUsage).where(
                            ExternalRequestUsage.user_id == user_id,
                            ExternalRequestUsage.scope_kind == budget.scope_kind,
                            ExternalRequestUsage.scope_id == budget.scope_id,
                            or_(
                                (ExternalRequestUsage.window_kind == "minute")
                                & (
                                    ExternalRequestUsage.window_start < instant - timedelta(days=30)
                                ),
                                (ExternalRequestUsage.window_kind == "day")
                                & (
                                    ExternalRequestUsage.window_start
                                    < instant - timedelta(days=366)
                                ),
                            ),
                        )
                    )


async def current_usage(
    session: AsyncSession, *, user_id: uuid.UUID, scope_kind: str, scope_id: uuid.UUID
) -> dict[str, int]:
    """현재 UTC 분/일의 예약 수. 제공자 청구/잔액이 아닌 앱의 보수적 시도 집계다."""
    instant = datetime.now(UTC)
    starts = {
        "minute": instant.replace(second=0, microsecond=0),
        "day": instant.replace(hour=0, minute=0, second=0, microsecond=0),
    }
    rows = await session.scalars(
        select(ExternalRequestUsage).where(
            ExternalRequestUsage.user_id == user_id,
            ExternalRequestUsage.scope_kind == scope_kind,
            ExternalRequestUsage.scope_id == scope_id,
            ExternalRequestUsage.window_start.in_(starts.values()),
        )
    )
    return {
        **dict.fromkeys(starts, 0),
        **{
            row.window_kind: row.reserved_count
            for row in rows
            if row.window_start == starts[row.window_kind]
        },
    }
