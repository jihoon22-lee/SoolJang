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
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.products import ensure_category_exists
from sooljang.infrastructure.database.models import ExternalLookupCache, ExternalSource, Product
from sooljang.infrastructure.external.adapter import fetch_snapshot

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


# --- 온디맨드 조회 ------------------------------------------------------------


class SourceLookupResult:
    """조회에 참여한 소스 하나의 결과. API 스키마가 이 필드를 그대로 옮겨 담는다."""

    def __init__(
        self,
        *,
        source_id: uuid.UUID,
        source_name: str,
        cached: bool,
        source_url: str | None,
        fields: dict[str, Any],
        raw_excerpt: str | None,
        degraded: bool,
        warning: str | None,
        fetched_at: datetime | None,
    ) -> None:
        self.source_id = source_id
        self.source_name = source_name
        self.cached = cached
        self.source_url = source_url
        self.fields = fields
        self.raw_excerpt = raw_excerpt
        self.degraded = degraded
        self.warning = warning
        self.fetched_at = fetched_at


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
                )
            )
            continue

        adapter_result = await fetch_snapshot(
            source.adapter_spec, base_url=source.base_url, query=product.name, transport=transport
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
                fetched_at=fetched_at,
            )
        )

    return results
