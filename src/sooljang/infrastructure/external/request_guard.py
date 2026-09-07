"""서버 작업 범위의 추가 송신 가드. 사용자 adapter 설정으로 주입할 수 없다."""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from sooljang.infrastructure.external.safe_http import BeforeRequest

_current_guard: ContextVar[BeforeRequest | None] = ContextVar(
    "sooljang_request_guard", default=None
)


@contextmanager
def outbound_guard(guard: BeforeRequest) -> Iterator[None]:
    token = _current_guard.set(guard)
    try:
        yield
    finally:
        _current_guard.reset(token)


async def check_outbound_guard(request: object) -> None:
    import httpx

    guard = _current_guard.get()
    if guard is not None:
        assert isinstance(request, httpx.Request)
        await guard(request)
