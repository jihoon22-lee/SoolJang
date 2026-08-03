"""`adapter` 전략 실행: 사이트별 CSS 셀렉터로 검색·상세 페이지를 파싱한다(Task 18).

`docs/architecture.md` §7.2 의 `adapter_spec` YAML 스키마를 그대로 JSON 으로 받는다.
`search` 로 후보를 찾고 이름이 가장 비슷한 하나를 골라 `detail` 셀렉터로 값을 뽑는다.

셀렉터가 깨지거나 robots.txt 가 막으면 예외 대신 `degraded=True` 부분 결과를 반환한다 —
사이트 구조 변경이나 접근 제한은 정상적으로 발생하는 일이라 전체 조회를 막아서는 안 된다
(§7.2). `source_url` 이 없는 결과는 호출자가 저장을 거부해야 한다(§7.1 절대 규칙).
"""

import difflib
import logging
import re
import time
import urllib.parse
import urllib.robotparser
from dataclasses import dataclass
from typing import Any

import httpx
from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 8.0
#: 프로젝트 식별자 + 연락 수단(§7.3) — 사이트 운영자가 이 요청의 출처를 알 수 있게 한다.
USER_AGENT = "SoolJangBot/1.0 (+https://github.com/jihoon22-lee/sooljang; personal-use lookup)"
#: 검색 후보 중 이 유사도 미만이면 "다른 술" 로 보고 후보 없음 취급한다.
_MIN_SIMILARITY = 0.4
_ROBOTS_TTL_SECONDS = 24 * 3600

#: 도메인별 robots.txt 파서 캐시. 단일 프로세스 배포(§8.1)라 인메모리로 충분하다 —
#: 재시작하면 다시 받아올 뿐 정확성 문제는 없다.
_robots_cache: dict[str, tuple[urllib.robotparser.RobotFileParser, float]] = {}


def reset_robots_cache() -> None:
    """테스트 편의를 위한 초기화. 같은 도메인에 서로 다른 robots.txt 를 흉내 내는 테스트가
    앞선 테스트의 캐시를 물려받지 않게 한다."""
    _robots_cache.clear()


@dataclass
class AdapterResult:
    """`FetchedSnapshot`(§7.1)에 대응하는 조회 결과 하나."""

    source_url: str | None
    fields: dict[str, Any]
    raw_excerpt: str | None
    degraded: bool
    warning: str | None


def _normalize(text: str) -> str:
    return re.sub(r"\s+", "", text).lower()


def _apply_transform(value: Any, transform: str) -> Any:
    if not isinstance(value, str):
        return value
    if transform == "strip_currency":
        return re.sub(r"[^\d.]", "", value)
    if transform == "to_number":
        cleaned = value.strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    raise ValueError(f"알 수 없는 transform: {transform!r}")


def _extract_field(scope: Tag | BeautifulSoup, spec: dict[str, Any], *, base_url: str) -> Any:
    """`adapter_spec` 의 필드 하나(`{selector, attr, transform}` 또는 `{const}`)를 계산한다."""
    if "const" in spec:
        return spec["const"]

    selector = spec.get("selector")
    node = scope.select_one(selector) if selector else scope
    if node is None:
        return None

    attr = spec.get("attr", "text")
    raw: Any = node.get_text(strip=True) or None if attr == "text" else node.get(attr)
    if raw is None:
        return None

    for transform in spec.get("transform", []):
        raw = _apply_transform(raw, transform)
        if raw is None:
            return None

    if spec.get("absolute") and isinstance(raw, str):
        raw = urllib.parse.urljoin(base_url, raw)
    return raw


async def _allowed(base_url: str, target_url: str, *, client: httpx.AsyncClient) -> bool:
    """robots.txt 가 `target_url` 을 허용하는지. 도메인 단위로 캐시한다(§7.3)."""
    parsed = urllib.parse.urlparse(base_url)
    domain = f"{parsed.scheme}://{parsed.netloc}"
    now = time.monotonic()
    cached = _robots_cache.get(domain)

    if cached is None or cached[1] < now:
        parser = urllib.robotparser.RobotFileParser()
        try:
            response = await client.get(f"{domain}/robots.txt")
            parser.parse(response.text.splitlines() if response.status_code == 200 else [])
        except httpx.HTTPError as error:
            # robots.txt 자체를 못 가져온 경우 규칙이 없다고 보고 허용한다 — 네트워크
            # 문제 한 번 때문에 사용자가 요청한 조회를 영구히 막지 않는다.
            logger.warning("robots.txt 조회 실패(%s): %s", domain, error)
            parser.parse([])
        _robots_cache[domain] = (parser, now + _ROBOTS_TTL_SECONDS)
    else:
        parser = cached[0]

    return parser.can_fetch(USER_AGENT, target_url)


async def fetch_snapshot(
    adapter_spec: dict[str, Any],
    *,
    base_url: str,
    query: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AdapterResult:
    """`query`(제품명)로 검색해 가장 비슷한 후보의 상세 정보를 가져온다.

    `transport` 는 테스트가 `httpx.MockTransport` 로 실제 네트워크 없이 응답을 흉내 낼 수
    있게 하는 자리다 — 운영에서는 항상 `None`(기본 전송).
    """
    search_spec = adapter_spec.get("search")
    if not search_spec:
        return AdapterResult(None, {}, None, True, "adapter_spec 에 search 설정이 없습니다")

    async with httpx.AsyncClient(
        timeout=_TIMEOUT_SECONDS, transport=transport, headers={"User-Agent": USER_AGENT}
    ) as client:
        search_url = search_spec["url_template"].format(query=urllib.parse.quote(query))

        if not await _allowed(base_url, search_url, client=client):
            return AdapterResult(
                None, {}, None, True, "robots.txt 가 검색 페이지 접근을 금지합니다"
            )

        try:
            response = await client.get(search_url)
            response.raise_for_status()
        except httpx.HTTPError as error:
            return AdapterResult(None, {}, None, True, f"검색 페이지 조회 실패: {error}")

        soup = BeautifulSoup(response.text, "html.parser")
        item_selector = search_spec.get("item")
        items = soup.select(item_selector) if item_selector else []
        fields_spec = search_spec.get("fields", {})
        candidates: list[tuple[str, str]] = []
        for item in items:
            name = _extract_field(item, fields_spec.get("name", {}), base_url=base_url)
            url = _extract_field(item, fields_spec.get("url", {}), base_url=base_url)
            if isinstance(name, str) and isinstance(url, str):
                candidates.append((name, url))

        if not candidates:
            return AdapterResult(None, {}, None, True, "검색 결과에서 후보를 찾지 못했습니다")

        best_name, best_url = max(
            candidates,
            key=lambda c: difflib.SequenceMatcher(
                None, _normalize(c[0]), _normalize(query)
            ).ratio(),
        )
        similarity = difflib.SequenceMatcher(None, _normalize(best_name), _normalize(query)).ratio()
        if similarity < _MIN_SIMILARITY:
            return AdapterResult(
                None, {}, None, True, f"충분히 비슷한 후보가 없습니다(가장 가까움: {best_name!r})"
            )

        if not await _allowed(base_url, best_url, client=client):
            return AdapterResult(
                None, {}, None, True, "robots.txt 가 상세 페이지 접근을 금지합니다"
            )

        try:
            detail_response = await client.get(best_url)
            detail_response.raise_for_status()
        except httpx.HTTPError as error:
            return AdapterResult(best_url, {}, None, True, f"상세 페이지 조회 실패: {error}")

        detail_soup = BeautifulSoup(detail_response.text, "html.parser")
        detail_fields_spec: dict[str, Any] = adapter_spec.get("detail", {}).get("fields", {})
        fields: dict[str, Any] = {}
        missing: list[str] = []
        for field_name, field_spec in detail_fields_spec.items():
            value = _extract_field(detail_soup, field_spec, base_url=base_url)
            fields[field_name] = value
            if value is None:
                missing.append(field_name)

        excerpt = detail_soup.get_text(" ", strip=True)[:500] or None
        degraded = bool(missing)
        warning = f"일부 항목을 확인하지 못했습니다: {', '.join(missing)}" if missing else None
        return AdapterResult(best_url, fields, excerpt, degraded, warning)
