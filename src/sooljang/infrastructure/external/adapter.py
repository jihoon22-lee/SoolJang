"""`adapter` 전략 실행: 사이트별 CSS 셀렉터로 검색·상세 페이지를 파싱한다(Task 18).

`docs/architecture.md` §7.2 의 `adapter_spec` YAML 스키마를 그대로 JSON 으로 받는다.
`search` 로 후보를 찾고 이름이 가장 비슷한 하나를 골라 `detail` 셀렉터로 값을 뽑는다.

셀렉터가 깨지거나 robots.txt 가 막으면 예외 대신 `degraded=True` 부분 결과를 반환한다 —
사이트 구조 변경이나 접근 제한은 정상적으로 발생하는 일이라 전체 조회를 막아서는 안 된다
(§7.2). `source_url` 이 없는 결과는 호출자가 저장을 거부해야 한다(§7.1 절대 규칙).

`adapter_spec` 은 사용자가 등록 화면에서 직접 쓰는 JSON 이라 모양이 자유롭게 틀릴 수
있다(오타 난 transform 이름, `{}` 만 있는 url_template, 문자열이어야 할 자리에 dict 가
아닌 값 등) — 이런 입력이 예외를 던지면 그 소스 하나 때문에 같은 요청에 포함된 다른
소스의 결과까지 500 으로 함께 죽는다(어댑터 계약 위반). 그래서 필드 추출과 이 모듈의
공개 함수 전체를 방어적으로 감싼다: 여기서 예외가 새 나가는 일은 없어야 한다.

**JSON 모드(Task 24 후속)**: `adapter_spec.format == "json"` 이면 검색 응답을 HTML 대신
JSON 으로 파싱한다 — 최근 국내 쇼핑몰은 Next.js 등으로 만들어져 검색 결과 페이지의 HTML
을 그대로 받으면 상품 정보가 비어 있고, 대신 브라우저가 별도로 호출하는 공개 JSON API 가
있는 경우가 흔하다(데일리샷에서 실제로 겪음). 이 모드에서는 `search.item` 이 CSS 셀렉터가
아니라 리스트를 가리키는 점 구분 JSON 경로이고, 필드 스펙은 `selector` 대신 `path` 를 쓴다.
검색 응답 자체에 상세 정보가 이미 다 있는 사이트를 위해 `search.result_fields` 를 쓸 수도
있다 — 이게 있으면 상세 페이지를 다시 조회하지 않고 검색 결과 아이템에서 바로 최종 필드를
뽑는다(불필요한 왕복을 줄인다). 상세 페이지 링크가 `href` 로 바로 주어지지 않고 아이템의
다른 필드로부터 조립해야 하면(`id`→URL 등) 필드 스펙에 `url_template` 을 쓴다 — 아이템의
최상위 필드들을 그대로 치환한다(`{"url_template": "https://x.com/item/{id}"}` 가
`item["id"]` 를 채운다)."""

import difflib
import json
import logging
import math
import re
import time
import urllib.parse
import urllib.robotparser
from dataclasses import dataclass, field
from typing import Any

import httpx
from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 8.0
#: 프로젝트 식별자 + 연락 수단(§7.3) — 사이트 운영자가 이 요청의 출처를 알 수 있게 한다.
USER_AGENT = "SoolJangBot/1.0 (+https://github.com/jihoon22-lee/sooljang; personal-use lookup)"
#: 후보 점수를 세 구간으로 나눈다(Task 34 PR1). 매칭이 100% 가 될 수 없다는 전제 위에서,
#: 확신이 없으면 확신이 없다고 말하고 사용자가 고를 수 있게 하는 것이 목적이다.
#:
#:   score >= AUTO_ACCEPT  : 자동 채택. 지금까지처럼 값을 바로 보여준다
#:   MIN_CANDIDATE ~ AUTO  : 값은 보여주되 `needs_confirmation=True` — 후보를 함께 노출
#:   score <  MIN_CANDIDATE: 값 없음. 후보만 노출해 사용자가 직접 고르게 한다
#:
#: 기존 임계값은 0.4 하나였는데 실측상 "아무거나 통과" 에 가까웠다. 두 값 모두 PR2 에서
#: 점수 함수(토큰 집합 + 하드 제약)가 바뀌면 재조정해야 한다.
MIN_CANDIDATE = 0.5
AUTO_ACCEPT = 0.85
#: 사용자에게 보여줄 후보 최대 개수. 더 늘리면 카드가 길어지기만 한다.
MAX_CANDIDATES = 5
_ROBOTS_TTL_SECONDS = 24 * 3600
#: 리다이렉트를 따라가되 무한 루프성 설정을 방어한다.
_MAX_REDIRECTS = 5

#: 도메인별 robots.txt 파서 캐시. 단일 프로세스 배포(§8.1)라 인메모리로 충분하다 —
#: 재시작하면 다시 받아올 뿐 정확성 문제는 없다.
_robots_cache: dict[str, tuple[urllib.robotparser.RobotFileParser, float]] = {}


def reset_robots_cache() -> None:
    """테스트 편의를 위한 초기화. 같은 도메인에 서로 다른 robots.txt 를 흉내 내는 테스트가
    앞선 테스트의 캐시를 물려받지 않게 한다."""
    _robots_cache.clear()


@dataclass(frozen=True)
class LookupCandidate:
    """검색 결과 후보 하나. 사용자가 이 중에서 고르면 고정(pin)이 된다."""

    name: str
    url: str
    key: str | None
    score: float


@dataclass(frozen=True)
class PinnedMatch:
    """사용자가 확정해 둔 매칭. `fetch_snapshot` 에 넘기면 유사도 대신 이걸 쓴다."""

    external_url: str
    external_key: str | None


@dataclass
class AdapterResult:
    """`FetchedSnapshot`(§7.1)에 대응하는 조회 결과 하나."""

    source_url: str | None
    fields: dict[str, Any]
    raw_excerpt: str | None
    degraded: bool
    warning: str | None
    #: 상세 페이지를 실제로 성공적으로 가져와 파싱했는지. `source_url` 이 채워져 있어도
    #: 이 값이 `False` 면(예: 상세 페이지 조회 자체가 실패) 호출자는 결과를 캐시하면 안
    #: 된다 — 실패를 성공처럼 TTL 동안 붙잡아 두게 된다.
    ok: bool = False
    #: 실제로 고른 후보의 이름. 화면이 "무엇에 매칭됐는지" 를 보여줄 수 있게 한다 —
    #: 지금까지는 이 값이 없어 엉뚱한 술이 매칭돼도 사용자가 알아챌 방법이 없었다.
    matched_name: str | None = None
    match_score: float | None = None
    #: 고른 후보의 식별자. 캐시 스냅샷에 남겨 무엇에 매칭됐는지를 기록한다.
    matched_key: str | None = None
    #: 점수가 확신 구간에 못 미쳐 사용자 확인이 필요한지.
    needs_confirmation: bool = False
    #: 상위 후보들(점수 내림차순, 최대 `MAX_CANDIDATES` 개). 사용자가 다른 것을 고를 수
    #: 있게 하려는 목적이라, 자동 채택된 경우에도 함께 돌려준다.
    candidates: list[LookupCandidate] = field(default_factory=list)
    #: 이 결과가 사용자가 고정해 둔 매칭으로부터 나왔는지.
    pinned: bool = False


def _normalize(text: str) -> str:
    return re.sub(r"\s+", "", text).lower()


def _similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


#: 브랜드·증류소 이름은 보통 상품명 맨 앞 몇 글자에 담긴다(글렌피딕/부나하벤/아벨라워 등).
#: 전체 문자열 유사도만 보면 "글렌고인"과 "글렌리벳" 처럼 접두사만 같고 실제로는 다른
#: 증류소인 이름이 높은 점수를 받는다(둘 다 "글렌…" 이라 문자 겹침이 크다) — 실측으로
#: 확인했다. 이 접두사 게이트가 그런 오탐을 걸러낸다. 단, "우드포드 리저브" 검색어가
#: "우드포드 리저브 라이"(다른 제품)의 완전한 접두사인 경우처럼, 검색어 자체가 다른
#: 상품명의 앞부분과 완전히 겹치는 경우는 이 게이트로 걸러지지 않는다 — 순수 문자열
#: 비교로는 원천적으로 구분할 수 없는 남은 한계다.
_PREFIX_LENGTH = 4
_MIN_PREFIX_SIMILARITY = 0.75


def _plausible_candidate(query_norm: str, name_norm: str) -> bool:
    return (
        _similarity(query_norm[:_PREFIX_LENGTH], name_norm[:_PREFIX_LENGTH])
        >= _MIN_PREFIX_SIMILARITY
    )


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
            number = float(cleaned)
        except ValueError:
            return None
        # "Infinity"/"nan" 처럼 파이썬은 파싱하지만 JSON/Postgres JSONB 는 담을 수 없는
        # 값은 애초에 필드가 없었던 것으로 취급한다.
        return number if math.isfinite(number) else None
    # 등록 화면에서 오타를 낸 transform 이름 — 이 필드 하나만 못 뽑을 뿐, 조회 전체를
    # 막을 이유가 없다.
    logger.warning("알 수 없는 transform 이라 건너뜁니다: %r", transform)
    return None


def _extract_field(scope: Tag | BeautifulSoup, spec: Any, *, base_url: str) -> Any:
    """`adapter_spec` 의 필드 하나(`{selector, attr, transform}` 또는 `{const}`)를 계산한다.

    `spec` 자체가 dict 가 아니거나(예: 필드 값에 문자열을 직접 씀), 셀렉터 문법이
    잘못됐거나(soupsieve 가 예외를 던진다), 그 밖의 예상 못 한 모양이어도 예외를 밖으로
    내보내지 않는다 — 그 필드만 조용히 빠진다(§7.2 의 "부분 결과 + 경고" 계약).
    """
    if not isinstance(spec, dict):
        return None
    if "const" in spec:
        return spec["const"]

    try:
        selector = spec.get("selector")
        node = scope.select_one(selector) if selector else scope
        if node is None:
            return None

        attr = spec.get("attr", "text")
        raw: Any = node.get_text(strip=True) or None if attr == "text" else node.get(attr)
        if raw is None:
            return None

        transforms = spec.get("transform", [])
        for transform in transforms if isinstance(transforms, list) else []:
            raw = _apply_transform(raw, transform)
            if raw is None:
                return None

        if spec.get("absolute") and isinstance(raw, str):
            raw = urllib.parse.urljoin(base_url, raw)
        return raw
    except Exception:
        logger.warning("필드 추출 중 예외가 나 건너뜁니다: spec=%r", spec, exc_info=True)
        return None


def _get_json_path(data: Any, path: str) -> Any:
    """점으로 구분한 경로로 중첩된 JSON 값을 찾는다(`"results"`, `"a.0.b"` 등). 숫자
    구간은 리스트 인덱스로 쓴다. 중간에 못 찾으면(키 없음, 타입 불일치, 인덱스 범위 밖)
    예외 대신 `None` 을 돌려준다 — `_extract_field` 의 CSS 셀렉터 실패와 같은 계약이다."""
    current = data
    for segment in path.split("."):
        try:
            if isinstance(current, dict):
                current = current[segment]
            elif isinstance(current, list):
                current = current[int(segment)]
            else:
                return None
        except KeyError, IndexError, ValueError, TypeError:
            return None
    return current


def _extract_field_json(item: Any, spec: Any) -> Any:
    """`_extract_field` 의 JSON 버전 — `item` 은 파싱된 JSON 값(보통 dict) 하나다.

    `url_template` 이 있으면 `item` 의 최상위 필드들로 바로 치환한다 — JSON API 는 상세
    페이지 링크를 `href` 로 주지 않고 `id` 같은 필드로부터 조립해야 하는 경우가 많다.
    """
    if not isinstance(spec, dict):
        return None
    if "const" in spec:
        return spec["const"]

    try:
        if "url_template" in spec:
            template = spec["url_template"]
            if not isinstance(template, str) or not isinstance(item, dict):
                return None
            return template.format(**item)

        path = spec.get("path")
        value = _get_json_path(item, path) if isinstance(path, str) else item
        if value is None:
            return None

        transforms = spec.get("transform", [])
        for transform in transforms if isinstance(transforms, list) else []:
            value = _apply_transform(value, transform)
            if value is None:
                return None
        return value
    except Exception:
        logger.warning("JSON 필드 추출 중 예외가 나 건너뜁니다: spec=%r", spec, exc_info=True)
        return None


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


def _same_host(base_url: str, candidate_url: str) -> bool:
    """`candidate_url` 이 `base_url` 과 같은 호스트의 http(s) 주소인지.

    검색 결과 페이지의 링크는 신뢰할 수 없는 원격 콘텐츠다 — 검색된 링크를 그대로
    따라가면, 등록한 사이트가 (또는 그 사이트에 실린 광고·제휴 링크가) 사설망·클라우드
    메타데이터 엔드포인트 등 전혀 다른 호스트를 가리키게 만들 수 있다(SSRF). 등록된
    소스와 같은 호스트가 아니면 상세 페이지를 아예 조회하지 않는다.
    """
    base_host = urllib.parse.urlparse(base_url).netloc.lower()
    candidate = urllib.parse.urlparse(candidate_url)
    return candidate.scheme in ("http", "https") and candidate.netloc.lower() == base_host


def _uses_result_fields(adapter_spec: dict[str, Any], search_spec: dict[str, Any]) -> bool:
    """검색 응답 자체에서 최종 값을 뽑는 소스인지(`search.result_fields`, 데일리샷 등).

    이 구분이 고정(pin) 동작을 가른다. 상세 페이지가 따로 있는 소스는 고정된 URL 을 바로
    조회하면 되지만, 이 모드는 값이 검색 응답 안에만 있어 **검색을 건너뛸 수 없다** —
    검색은 하되 후보 선택만 유사도 대신 고정된 키로 한다.
    """
    result_fields = search_spec.get("result_fields")
    return (
        adapter_spec.get("format") == "json"
        and isinstance(result_fields, dict)
        and bool(result_fields)
    )


def _missing_warning(missing: list[str]) -> str | None:
    return f"일부 항목을 확인하지 못했습니다: {', '.join(missing)}" if missing else None


def _extract_named_fields(extract: Any, spec: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """필드 스펙 dict 를 돌며 값을 뽑고, 못 뽑은 이름을 함께 돌려준다."""
    fields: dict[str, Any] = {}
    missing: list[str] = []
    for field_name, field_spec in spec.items():
        value = extract(field_spec)
        fields[field_name] = value
        if value is None:
            missing.append(field_name)
    return fields, missing


#: 점수를 매긴 후보 하나와, JSON 모드에서 값을 뽑을 원본 아이템.
_ScoredCandidate = tuple[LookupCandidate, dict[str, Any] | None]


def _score_candidates(
    query: str, raw: list[tuple[str, str, dict[str, Any] | None]]
) -> list[_ScoredCandidate]:
    """후보에 점수를 매겨 내림차순으로 정렬한다.

    점수 함수 자체는 아직 전체 문자열 유사도 하나다 — Task 34 PR2 에서 토큰 집합과
    하드 제약(용량·연수·빈티지·도수)으로 교체한다.
    """
    query_norm = _normalize(query)
    scored: list[_ScoredCandidate] = []
    for name, url, item in raw:
        # JSON API 는 관례적으로 `id` 를 식별자로 쓴다. 다른 이름이면 키가 비지만,
        # 고정은 URL 로도 후보를 되찾을 수 있어(`_match_pinned`) 동작에 문제가 없다.
        key = item.get("id") if isinstance(item, dict) else None
        scored.append(
            (
                LookupCandidate(
                    name=name,
                    url=url,
                    key=str(key) if key is not None else None,
                    score=_similarity(query_norm, _normalize(name)),
                ),
                item,
            )
        )
    scored.sort(key=lambda entry: entry[0].score, reverse=True)
    return scored


def _match_pinned(scored: list[_ScoredCandidate], pinned: PinnedMatch) -> _ScoredCandidate | None:
    """고정된 매칭에 해당하는 후보를 찾는다. 키가 있으면 키 우선, 없으면 URL 로 찾는다.

    **유사도로 폴백하지 않는다.** 못 찾으면 `None` 을 돌려주고 호출자가 경고를 낸다 —
    조용히 다른 상품으로 되돌아가면 고정의 의미가 사라진다.
    """
    if pinned.external_key is not None:
        for entry in scored:
            if entry[0].key == pinned.external_key:
                return entry
    for entry in scored:
        if entry[0].url == pinned.external_url:
            return entry
    return None


def is_same_host(base_url: str, candidate_url: str) -> bool:
    """`_same_host` 의 공개 이름.

    고정(pin)을 **저장할 때도** 같은 검증을 해야 한다 — 클라이언트가 보낸 URL 을 그대로
    믿을 이유가 없다. 조회 시점 검증은 어댑터 안에서 따로 한 번 더 한다(저장 후에 소스의
    `base_url` 이 바뀔 수 있다).
    """
    return _same_host(base_url, candidate_url)


async def fetch_snapshot(
    adapter_spec: dict[str, Any],
    *,
    base_url: str,
    query: str,
    transport: httpx.AsyncBaseTransport | None = None,
    pinned: PinnedMatch | None = None,
) -> AdapterResult:
    """`query`(제품명)로 검색해 가장 비슷한 후보의 상세 정보를 가져온다.

    `pinned` 가 있으면 유사도 대신 사용자가 확정해 둔 매칭을 쓴다(Task 34 PR1).

    `transport` 는 테스트가 `httpx.MockTransport` 로 실제 네트워크 없이 응답을 흉내 낼 수
    있게 하는 자리다 — 운영에서는 항상 `None`(기본 전송).
    """
    try:
        return await _fetch_snapshot_unsafe(
            adapter_spec, base_url=base_url, query=query, transport=transport, pinned=pinned
        )
    except Exception as error:
        # 여기까지 오는 건 아래 구체적인 방어로도 못 잡은 진짜 예상 밖의 adapter_spec
        # 모양이다 — 그래도 이 함수의 계약("절대 예외를 던지지 않는다")은 지킨다.
        logger.warning("adapter_spec 처리 중 예상 못 한 예외: %s", error, exc_info=True)
        return AdapterResult(None, {}, None, True, f"adapter_spec 처리 실패: {error}")


async def _fetch_pinned_detail(
    adapter_spec: dict[str, Any],
    *,
    base_url: str,
    pinned: PinnedMatch,
    client: httpx.AsyncClient,
) -> AdapterResult:
    """고정된 URL 의 상세 페이지를 직접 조회한다 — 검색 왕복을 건너뛴다.

    저장 시점에 호스트를 검증했더라도 여기서 다시 확인한다. 저장 후에 소스의 `base_url`
    이 바뀌었을 수 있다(SSRF 방어, §7.2).
    """
    if not _same_host(base_url, pinned.external_url):
        return AdapterResult(
            None, {}, None, True, "고정된 링크가 등록된 사이트 밖을 가리켜 건너뜁니다", pinned=True
        )
    if not await _allowed(base_url, pinned.external_url, client=client):
        return AdapterResult(
            None, {}, None, True, "robots.txt 가 상세 페이지 접근을 금지합니다", pinned=True
        )
    return await _fetch_detail(
        adapter_spec,
        base_url=base_url,
        url=pinned.external_url,
        client=client,
        matched_name=None,
        match_score=None,
        matched_key=pinned.external_key,
        candidates=[],
        pinned=True,
    )


async def _fetch_detail(
    adapter_spec: dict[str, Any],
    *,
    base_url: str,
    url: str,
    client: httpx.AsyncClient,
    matched_name: str | None,
    match_score: float | None,
    matched_key: str | None,
    candidates: list[LookupCandidate],
    pinned: bool,
) -> AdapterResult:
    """상세 페이지를 받아 `detail.fields` 셀렉터로 값을 뽑는다."""
    try:
        detail_response = await client.get(url)
        detail_response.raise_for_status()
    except httpx.HTTPError as error:
        return AdapterResult(
            url,
            {},
            None,
            True,
            f"상세 페이지 조회 실패: {error}",
            matched_name=matched_name,
            match_score=match_score,
            matched_key=matched_key,
            candidates=candidates,
            pinned=pinned,
        )

    # 리다이렉트를 따라간 뒤 최종 주소도 같은 호스트인지 다시 확인한다 — 등록한
    # 사이트 자체가 공격받아 다른 호스트로 리다이렉트하도록 바뀌었을 가능성을 막는다.
    if not _same_host(base_url, str(detail_response.url)):
        return AdapterResult(
            None,
            {},
            None,
            True,
            "상세 페이지가 등록된 사이트 밖으로 리다이렉트됐습니다",
            candidates=candidates,
            pinned=pinned,
        )

    detail_soup = BeautifulSoup(detail_response.text, "html.parser")
    detail_section = adapter_spec.get("detail")
    detail_fields_spec = detail_section.get("fields") if isinstance(detail_section, dict) else None
    if not isinstance(detail_fields_spec, dict):
        detail_fields_spec = {}
    fields, missing = _extract_named_fields(
        lambda spec: _extract_field(detail_soup, spec, base_url=base_url), detail_fields_spec
    )
    excerpt = detail_soup.get_text(" ", strip=True)[:500] or None
    return AdapterResult(
        url,
        fields,
        excerpt,
        bool(missing),
        _missing_warning(missing),
        ok=True,
        matched_name=matched_name,
        match_score=match_score,
        matched_key=matched_key,
        candidates=candidates,
        pinned=pinned,
    )


async def _fetch_snapshot_unsafe(
    adapter_spec: dict[str, Any],
    *,
    base_url: str,
    query: str,
    transport: httpx.AsyncBaseTransport | None,
    pinned: PinnedMatch | None,
) -> AdapterResult:
    search_spec = adapter_spec.get("search")
    if not isinstance(search_spec, dict):
        return AdapterResult(None, {}, None, True, "adapter_spec 에 search 설정이 없습니다")

    async with httpx.AsyncClient(
        timeout=_TIMEOUT_SECONDS,
        transport=transport,
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        max_redirects=_MAX_REDIRECTS,
    ) as client:
        # 고정돼 있고 상세 페이지가 따로 있는 소스면 검색 자체를 건너뛴다.
        if pinned is not None and not _uses_result_fields(adapter_spec, search_spec):
            return await _fetch_pinned_detail(
                adapter_spec, base_url=base_url, pinned=pinned, client=client
            )

        url_template = search_spec.get("url_template")
        if not isinstance(url_template, str):
            return AdapterResult(
                None, {}, None, True, "adapter_spec.search.url_template 이 없습니다"
            )
        try:
            search_url = url_template.format(query=urllib.parse.quote(query))
        except (KeyError, IndexError, ValueError) as error:
            return AdapterResult(None, {}, None, True, f"url_template 형식이 잘못됐습니다: {error}")

        if not await _allowed(base_url, search_url, client=client):
            return AdapterResult(
                None, {}, None, True, "robots.txt 가 검색 페이지 접근을 금지합니다"
            )

        try:
            response = await client.get(search_url)
            response.raise_for_status()
        except httpx.HTTPError as error:
            return AdapterResult(None, {}, None, True, f"검색 페이지 조회 실패: {error}")

        fields_spec = search_spec.get("fields")
        if not isinstance(fields_spec, dict):
            fields_spec = {}

        is_json = adapter_spec.get("format") == "json"
        #: (이름, 링크, 원본 JSON 아이템 또는 None) — JSON 모드는 상세를 다시 조회하지
        #: 않고 이 원본 아이템에서 바로 결과 필드를 뽑을 수도 있어(`result_fields`) 붙여
        #: 둔다. HTML 모드는 늘 `None` 이다.
        raw: list[tuple[str, str, dict[str, Any] | None]] = []
        if is_json:
            try:
                parsed = response.json()
            except ValueError:
                return AdapterResult(None, {}, None, True, "검색 응답이 올바른 JSON이 아닙니다")
            item_path = search_spec.get("item")
            items_data = _get_json_path(parsed, item_path) if isinstance(item_path, str) else parsed
            for raw_item in items_data if isinstance(items_data, list) else []:
                if not isinstance(raw_item, dict):
                    continue
                name = _extract_field_json(raw_item, fields_spec.get("name"))
                url = _extract_field_json(raw_item, fields_spec.get("url"))
                if isinstance(name, str) and isinstance(url, str):
                    raw.append((name, url, raw_item))
        else:
            soup = BeautifulSoup(response.text, "html.parser")
            item_selector = search_spec.get("item")
            items = soup.select(item_selector) if isinstance(item_selector, str) else []
            for item in items:
                name = _extract_field(item, fields_spec.get("name"), base_url=base_url)
                url = _extract_field(item, fields_spec.get("url"), base_url=base_url)
                if isinstance(name, str) and isinstance(url, str):
                    raw.append((name, url, None))

        if not raw:
            return AdapterResult(
                None,
                {},
                None,
                True,
                "검색 결과에서 후보를 찾지 못했습니다",
                pinned=pinned is not None,
            )

        scored = _score_candidates(query, raw)
        # 자동 채택 여부와 무관하게 상위 후보를 늘 함께 돌려준다 — 사용자가 다른 것을
        # 고를 수 있어야 하기 때문이다(진단 6번).
        candidates = [entry[0] for entry in scored[:MAX_CANDIDATES]]

        if pinned is not None:
            selected = _match_pinned(scored, pinned)
            if selected is None:
                return AdapterResult(
                    None,
                    {},
                    None,
                    True,
                    "고정된 상품을 검색 결과에서 찾지 못했습니다",
                    candidates=candidates,
                    pinned=True,
                )
        else:
            query_norm = _normalize(query)
            plausible = [
                entry
                for entry in scored
                if _plausible_candidate(query_norm, _normalize(entry[0].name))
            ]
            if not plausible:
                return AdapterResult(
                    None,
                    {},
                    None,
                    True,
                    "이름 앞부분이 충분히 비슷한 후보가 없습니다"
                    f"(가장 가까움: {scored[0][0].name!r})",
                    candidates=candidates,
                )
            selected = plausible[0]
            if selected[0].score < MIN_CANDIDATE:
                return AdapterResult(
                    None,
                    {},
                    None,
                    True,
                    f"충분히 비슷한 후보가 없습니다(가장 가까움: {selected[0].name!r})",
                    candidates=candidates,
                )

        best, best_item = selected
        needs_confirmation = pinned is None and best.score < AUTO_ACCEPT

        if not _same_host(base_url, best.url):
            return AdapterResult(
                None,
                {},
                None,
                True,
                "검색 결과 링크가 등록된 사이트 밖을 가리켜 건너뜁니다",
                candidates=candidates,
                pinned=pinned is not None,
            )

        result_fields_spec = search_spec.get("result_fields")
        if _uses_result_fields(adapter_spec, search_spec) and best_item is not None:
            # 검색 응답 자체에 이미 상세 정보가 있는 사이트다 — 상세 페이지를 또 조회하지
            # 않는다(불필요한 왕복 + robots.txt 재확인을 피한다).
            fields, missing = _extract_named_fields(
                lambda spec: _extract_field_json(best_item, spec), result_fields_spec
            )
            excerpt = json.dumps(best_item, ensure_ascii=False)[:500] or None
            return AdapterResult(
                best.url,
                fields,
                excerpt,
                bool(missing),
                _missing_warning(missing),
                ok=True,
                matched_name=best.name,
                match_score=best.score,
                matched_key=best.key,
                needs_confirmation=needs_confirmation,
                candidates=candidates,
                pinned=pinned is not None,
            )

        if not await _allowed(base_url, best.url, client=client):
            return AdapterResult(
                None,
                {},
                None,
                True,
                "robots.txt 가 상세 페이지 접근을 금지합니다",
                candidates=candidates,
                pinned=pinned is not None,
            )

        result = await _fetch_detail(
            adapter_spec,
            base_url=base_url,
            url=best.url,
            client=client,
            matched_name=best.name,
            match_score=best.score,
            matched_key=best.key,
            candidates=candidates,
            pinned=pinned is not None,
        )
        result.needs_confirmation = needs_confirmation
        return result
