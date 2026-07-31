"""DB 엔진·세션 계층 테스트.

실제 PostgreSQL 없이 성공·실패 경로를 모두 덮기 위해 엔진을 스텁으로 대체한다.
실제 연결을 쓰는 검증은 `requires_db` 마커로 분리한다.
"""

from types import TracebackType
from typing import Any, Self

import pytest

from sooljang.infrastructure.database import session as session_module


class _StubResult:
    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self._row = row

    def first(self) -> tuple[Any, ...] | None:
        return self._row


class _StubConnection:
    def __init__(self, row: tuple[Any, ...] | None = None, fail: bool = False) -> None:
        self._row = row
        self._fail = fail

    async def __aenter__(self) -> Self:
        if self._fail:
            raise OSError("connection refused")
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None

    async def execute(self, _statement: object) -> _StubResult:
        return _StubResult(self._row)


class _StubEngine:
    def __init__(self, row: tuple[Any, ...] | None = None, fail: bool = False) -> None:
        self._row = row
        self._fail = fail

    def connect(self) -> _StubConnection:
        return _StubConnection(self._row, self._fail)


def _use_engine(monkeypatch: pytest.MonkeyPatch, engine: _StubEngine) -> None:
    monkeypatch.setattr(session_module, "get_engine", lambda: engine)


async def test_check_connection_returns_true_when_query_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_engine(monkeypatch, _StubEngine(row=(1,)))
    assert await session_module.check_connection() is True


async def test_check_connection_returns_false_when_engine_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_engine(monkeypatch, _StubEngine(fail=True))
    assert await session_module.check_connection() is False


async def test_migration_revision_returns_applied_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_engine(monkeypatch, _StubEngine(row=("0001_enable_pg_trgm",)))
    assert await session_module.get_migration_revision() == "0001_enable_pg_trgm"


async def test_migration_revision_returns_none_when_table_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_engine(monkeypatch, _StubEngine(fail=True))
    assert await session_module.get_migration_revision() is None


async def test_migration_revision_returns_none_when_no_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_engine(monkeypatch, _StubEngine(row=None))
    assert await session_module.get_migration_revision() is None


def test_engine_is_reused_within_process() -> None:
    assert session_module.get_engine() is session_module.get_engine()
    assert session_module.get_session_factory() is session_module.get_session_factory()


def test_reset_database_state_discards_cached_engine() -> None:
    first = session_module.get_engine()
    session_module.reset_database_state()
    assert session_module.get_engine() is not first


async def test_get_session_yields_a_session() -> None:
    generator = session_module.get_session()
    session = await anext(generator)
    try:
        assert session.is_active
    finally:
        await generator.aclose()
