"""외부 소스 레지스트리 관리와 온디맨드 조회(Task 18).

`docs/architecture.md` §7 의 `adapter` 전략만 구현한다 — `search`(구글 검색 스크래핑)
전략은 ToS·신뢰성 위험 때문에 별도 PR 로 미뤘다(사용자 결정, plan.md Task 22).

조회(`lookup_product`)는 §7.3 준수 규칙을 여기서 강제한다: 소스별 `rate_limit_per_min`,
`ttl_hours` 내 캐시 재사용, `source_url` 없는 결과는 저장 거부. robots.txt 확인은
`infrastructure/external/adapter.py` 가 맡는다.

rate limit 은 인메모리 슬라이딩 윈도로 추적한다. 이 앱은 단일 프로세스로만 배포되므로
(§8.1) 서버 재시작 사이에 카운트가 리셋되는 정도는 안전 마진 안이다 — `LlmSetting` 의
"단일 활성 행을 애플리케이션 계층에서 강제" 판단과 같은 종류의 단순화다.
"""

import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.products import ensure_category_exists
from sooljang.infrastructure.database.models import (
    ExternalLookupCache,
    ExternalProductMatch,
    ExternalSource,
    Product,
)
from sooljang.infrastructure.external.adapter import (
    LookupCandidate,
    PinnedMatch,
    fetch_snapshot,
    is_same_host,
)

#: 소스별 최근 요청 시각(초, `time.monotonic()`). 슬라이딩 60초 윈도로 rate limit 을 본다.
_rate_limit_history: dict[uuid.UUID, list[float]] = {}


def reset_rate_limit_history() -> None:
    """테스트 편의를 위한 초기화. 앞선 테스트의 호출 이력이 다음 테스트의 rate limit
    판정에 새지 않게 한다(`application/auth.py::reset_rate_limiter` 와 같은 패턴)."""
    _rate_limit_history.clear()


def _rate_limit_ok(source_id: uuid.UUID, limit_per_min: int) -> bool:
    now = time.monotonic()
    history = [t for t in _rate_limit_history.get(source_id, []) if now - t < 60]
    if len(history) >= limit_per_min:
        _rate_limit_history[source_id] = history
        return False
    history.append(now)
    _rate_limit_history[source_id] = history
    return True


# --- 레지스트리 CRUD ---------------------------------------------------------


async def list_sources(session: AsyncSession, *, user_id: uuid.UUID) -> list[ExternalSource]:
    return list(
        await session.scalars(
            select(ExternalSource)
            .where(ExternalSource.user_id == user_id, ExternalSource.deleted_at.is_(None))
            .order_by(ExternalSource.priority, ExternalSource.name)
        )
    )


async def create_source(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    name: str,
    base_url: str,
    adapter_spec: dict[str, Any],
    category_id: uuid.UUID | None = None,
    priority: int = 0,
    is_active: bool = True,
    rate_limit_per_min: int = 6,
    ttl_hours: int = 24,
    note: str | None = None,
) -> ExternalSource:
    await ensure_category_exists(session, user_id=user_id, category_id=category_id)
    source = ExternalSource(
        user_id=user_id,
        name=name,
        base_url=base_url,
        adapter_spec=adapter_spec,
        category_id=category_id,
        priority=priority,
        is_active=is_active,
        rate_limit_per_min=rate_limit_per_min,
        ttl_hours=ttl_hours,
        note=note,
    )
    session.add(source)
    await session.flush()
    return source


async def get_owned_source(
    session: AsyncSession, *, user_id: uuid.UUID, source_id: uuid.UUID
) -> ExternalSource | None:
    source = await session.get(ExternalSource, source_id)
    if source is None or source.deleted_at is not None or source.user_id != user_id:
        return None
    return source


async def update_source(
    session: AsyncSession, source: ExternalSource, *, user_id: uuid.UUID, fields: dict[str, Any]
) -> ExternalSource:
    """부분 갱신. `fields` 는 요청에서 실제로 지정된 항목만 담는다(`exclude_unset`)."""
    if "category_id" in fields:
        await ensure_category_exists(session, user_id=user_id, category_id=fields["category_id"])
    for key in ("name", "base_url"):
        if key in fields and isinstance(fields[key], str):
            fields[key] = fields[key].strip()
    for key, value in fields.items():
        setattr(source, key, value)
    await session.flush()
    return source


async def delete_source(session: AsyncSession, source: ExternalSource) -> None:
    source.deleted_at = datetime.now(UTC)


# --- 매칭 고정 ----------------------------------------------------------------


class PinHostMismatchError(ValueError):
    """고정하려는 URL 이 소스의 `base_url` 과 다른 호스트다(§7.2 SSRF 방어)."""


async def get_match(
    session: AsyncSession, *, source_id: uuid.UUID, product_id: uuid.UUID
) -> ExternalProductMatch | None:
    return await session.scalar(
        select(ExternalProductMatch).where(
            ExternalProductMatch.source_id == source_id,
            ExternalProductMatch.product_id == product_id,
            ExternalProductMatch.deleted_at.is_(None),
        )
    )


async def _purge_cache(
    session: AsyncSession, *, source_id: uuid.UUID, product_id: uuid.UUID
) -> None:
    """고정이 바뀌면 그 (소스, 제품) 의 캐시를 버린다.

    캐시는 "이 제품을 이 소스에서 조회한 결과" 인데 고정을 바꾸면 그 결과가 가리키던
    상품 자체가 달라진다. 남겨 두면 `ttl_hours`(기본 24시간) 동안 옛 상품 값을 계속
    보여준다 — 고정을 고친 이유가 바로 그것이므로 즉시 버려야 한다.
    """
    await session.execute(
        delete(ExternalLookupCache).where(
            ExternalLookupCache.source_id == source_id,
            ExternalLookupCache.product_id == product_id,
        )
    )


async def pin_match(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source: ExternalSource,
    product_id: uuid.UUID,
    external_url: str,
    external_name: str,
    external_key: str | None = None,
) -> ExternalProductMatch:
    """ "이 제품 = 이 소스의 이 상품" 을 확정한다. 이미 있으면 덮어쓴다."""
    if not is_same_host(source.base_url, external_url):
        raise PinHostMismatchError(
            f"고정 대상 URL 이 소스의 주소와 다른 호스트입니다: {external_url}"
        )

    confirmed_at = datetime.now(UTC)
    match = await get_match(session, source_id=source.id, product_id=product_id)
    if match is None:
        match = ExternalProductMatch(
            user_id=user_id,
            source_id=source.id,
            product_id=product_id,
            external_url=external_url,
            external_name=external_name,
            external_key=external_key,
            confirmed_at=confirmed_at,
        )
        session.add(match)
    else:
        match.external_url = external_url
        match.external_name = external_name
        match.external_key = external_key
        match.confirmed_at = confirmed_at

    await _purge_cache(session, source_id=source.id, product_id=product_id)
    await session.flush()
    return match


async def unpin_match(
    session: AsyncSession, *, source_id: uuid.UUID, product_id: uuid.UUID
) -> bool:
    """고정을 해제한다. 해제할 것이 없었으면 `False`."""
    match = await get_match(session, source_id=source_id, product_id=product_id)
    if match is None:
        return False
    match.deleted_at = datetime.now(UTC)
    await _purge_cache(session, source_id=source_id, product_id=product_id)
    await session.flush()
    return True


# --- 온디맨드 조회 ------------------------------------------------------------


@dataclass
class SourceLookupResult:
    """조회에 참여한 소스 하나의 결과. API 스키마가 이 필드를 그대로 옮겨 담는다."""

    source_id: uuid.UUID
    source_name: str
    cached: bool
    source_url: str | None
    fields: dict[str, Any]
    raw_excerpt: str | None
    degraded: bool
    warning: str | None
    fetched_at: datetime | None
    #: 실제로 어떤 상품에 매칭됐는지와 그 확신도(Task 34 PR1). 화면이 "엉뚱한 술이
    #: 잡혔다" 를 사용자가 알아챌 수 있게 하는 값이다.
    matched_name: str | None = None
    match_score: float | None = None
    needs_confirmation: bool = False
    pinned: bool = False
    candidates: list[LookupCandidate] = field(default_factory=list)


async def _fresh_cache(
    session: AsyncSession, *, source: ExternalSource, product_id: uuid.UUID
) -> ExternalLookupCache | None:
    cutoff = datetime.now(UTC) - timedelta(hours=source.ttl_hours)
    cached = await session.scalar(
        select(ExternalLookupCache)
        .where(
            ExternalLookupCache.source_id == source.id,
            ExternalLookupCache.product_id == product_id,
        )
        .order_by(ExternalLookupCache.fetched_at.desc())
        .limit(1)
    )
    if cached is None or cached.fetched_at < cutoff:
        return None
    return cached


async def lookup_product(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    product: Product,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[SourceLookupResult]:
    """제품 이름으로 등록된 소스들을 조회한다. 사용자 조작(버튼 클릭)에서만 호출해야 한다.

    소스별로 독립적으로 시도한다 — 하나가 실패하거나 rate limit 에 걸려도 나머지는 계속
    진행한다. 결과가 없는 소스도 `degraded=True` 항목으로 포함해 사용자에게 "왜 안 나왔는지"
    보여준다.
    """
    sources = await session.scalars(
        select(ExternalSource)
        .where(
            ExternalSource.user_id == user_id,
            ExternalSource.deleted_at.is_(None),
            ExternalSource.is_active.is_(True),
        )
        .where(
            (ExternalSource.category_id.is_(None))
            | (ExternalSource.category_id == product.category_id)
        )
        .order_by(ExternalSource.priority, ExternalSource.name)
    )

    results: list[SourceLookupResult] = []
    for source in sources:
        match = await get_match(session, source_id=source.id, product_id=product.id)
        pinned = (
            PinnedMatch(external_url=match.external_url, external_key=match.external_key)
            if match is not None
            else None
        )

        cached = await _fresh_cache(session, source=source, product_id=product.id)
        if cached is not None:
            results.append(
                SourceLookupResult(
                    source_id=source.id,
                    source_name=source.name,
                    cached=True,
                    source_url=cached.snapshot.get("source_url"),
                    fields=cached.snapshot.get("fields", {}),
                    raw_excerpt=cached.snapshot.get("raw_excerpt"),
                    degraded=cached.degraded,
                    warning=cached.warning,
                    fetched_at=cached.fetched_at,
                    matched_name=cached.snapshot.get("matched_name"),
                    match_score=cached.snapshot.get("match_score"),
                    pinned=pinned is not None,
                )
            )
            continue

        if not _rate_limit_ok(source.id, source.rate_limit_per_min):
            results.append(
                SourceLookupResult(
                    source_id=source.id,
                    source_name=source.name,
                    cached=False,
                    source_url=None,
                    fields={},
                    raw_excerpt=None,
                    degraded=True,
                    warning="이 소스는 잠시 후 다시 시도해 주세요(요청 한도 초과)",
                    fetched_at=None,
                    pinned=pinned is not None,
                )
            )
            continue

        adapter_result = await fetch_snapshot(
            source.adapter_spec,
            base_url=source.base_url,
            query=product.name,
            transport=transport,
            pinned=pinned,
        )
        fetched_at = datetime.now(UTC)

        # 절대 규칙(§7.1): 출처 URL 이 없는 결과는 캐시에 저장하지 않는다. `ok` 도 함께
        # 확인한다 — 상세 페이지 조회 자체가 실패해도 `source_url` 은 채워져 있을 수
        # 있는데(어느 URL 을 시도했는지는 남긴다), 그 실패를 성공인 것처럼 TTL 동안
        # 캐시해 버리면 다음 조회도 계속 빈 결과만 돌려주게 된다. 매번 새로 시도하도록
        # 두되(다음 조회에서 다시 시도할 기회를 준다), 화면에는 이번 결과만 보여준다.
        if adapter_result.ok and adapter_result.source_url is not None:
            session.add(
                ExternalLookupCache(
                    user_id=user_id,
                    source_id=source.id,
                    product_id=product.id,
                    snapshot={
                        "source_url": adapter_result.source_url,
                        "fields": adapter_result.fields,
                        "raw_excerpt": adapter_result.raw_excerpt,
                        "matched_name": adapter_result.matched_name,
                        "match_score": adapter_result.match_score,
                        "external_key": adapter_result.matched_key,
                    },
                    degraded=adapter_result.degraded,
                    warning=adapter_result.warning,
                    fetched_at=fetched_at,
                )
            )
            await session.flush()

        results.append(
            SourceLookupResult(
                source_id=source.id,
                source_name=source.name,
                cached=False,
                source_url=adapter_result.source_url,
                fields=adapter_result.fields,
                raw_excerpt=adapter_result.raw_excerpt,
                degraded=adapter_result.degraded,
                warning=adapter_result.warning,
                matched_name=adapter_result.matched_name,
                match_score=adapter_result.match_score,
                needs_confirmation=adapter_result.needs_confirmation,
                pinned=adapter_result.pinned,
                candidates=adapter_result.candidates,
                fetched_at=fetched_at,
            )
        )

    return results
