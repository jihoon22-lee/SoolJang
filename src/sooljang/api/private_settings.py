"""연결/인증 설정 응답은 브라우저·프록시의 HTTP 캐시에 보관하지 않는다."""

from collections.abc import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import Response


async def private_settings_cache(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    path = request.url.path
    if path.startswith(("/api/v1/connections", "/api/v1/llm-settings", "/api/v1/price-watch")) or (
        path.startswith("/api/v1/external-sources") and path.endswith("/credentials")
    ):
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["Vary"] = ", ".join(filter(None, [response.headers.get("Vary"), "Cookie"]))
    return response
