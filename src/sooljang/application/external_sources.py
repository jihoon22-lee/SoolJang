"""외부 소스 레지스트리 관리와 온디맨드 조회(Task 18).

`docs/architecture.md` §7 의 `adapter` 전략만 구현한다 — `search`(구글 검색 스크래핑)
전략은 ToS·신뢰성 위험 때문에 별도 PR 로 미뤘다(사용자 결정, plan.md Task 22).

조회(`lookup_product`)는 §7.3 준수 규칙을 여기서 강제한다: 소스별 `rate_limit_per_min`,
`ttl_hours` 내 캐시 재사용, `source_url` 없는 결과는 저장 거부. robots.txt 확인은
`infrastructure/external/adapter.py` 가 맡는다.

robots·검색·상세·redirect·retry의 각 요청은 별도 영속 트랜잭션에서 예산을 예약한다.
주 조회의 실패/롤백과 프로세스 재시작으로 요청 한도가 초기화되지 않는다.
"""

import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import delete, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import NotFoundError, ValidationFailedError
from sooljang.application.external_offers import last_observed_offers, record_offers
from sooljang.application.external_request_usage import (
    RequestBudget,
    current_usage,
    reserve_request,
)
from sooljang.application.llm_settings import get_llm_setting
from sooljang.application.products import ensure_category_exists, load_product
from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.database.models import (
    ExternalLlmRematchLog,
    ExternalLookupCache,
    ExternalProductMatch,
    ExternalSource,
    ExternalSourceCredential,
    ExternalSourceProbe,
    Product,
    ProviderConnection,
    Sku,
)
from sooljang.infrastructure.external.adapter import (
    AdapterResult,
    LookupCandidate,
    PinnedMatch,
    fetch_snapshot,
    is_same_host,
)
from sooljang.infrastructure.external.fields import NormalizedFields, split_fields
from sooljang.infrastructure.external.match_llm import rematch as llm_rematch
from sooljang.infrastructure.external.matching import ProductIdentity
from sooljang.infrastructure.external.offers import prepare_offer, raw_offer
from sooljang.infrastructure.external.presets import get_preset
from sooljang.infrastructure.external.request_guard import outbound_guard
from sooljang.infrastructure.security.secrets import InvalidToken, decrypt_secret, encrypt_secret

#: 설정 revision을 함께 저장하여 키/파싱 계약 변경 후 과거 캐시를 재사용하지 않는다.
SNAPSHOT_VERSION = 4


# --- 레지스트리 CRUD ---------------------------------------------------------


def _sync_preset_if_stale(source: ExternalSource) -> bool:
    """프리셋 버전이 오르면 `adapter_spec`을 최신으로 맞춘다(Task 34 PR5). 갱신했으면 True.

    `spec_overridden` 인 소스는 건드리지 않는다 — 사용자가 직접 고친 스펙을 앱 업데이트가
    덮어쓰지 않는다는 것이 이 필드가 존재하는 이유다.
    """
    if source.preset_key is None or source.spec_overridden:
        return False
    preset = get_preset(source.preset_key)
    if preset is None or preset.version <= (source.preset_version or 0):
        return False
    source.adapter_spec = preset.adapter_spec
    source.base_url = preset.base_url
    source.preset_version = preset.version
    source.config_revision += 1
    return True


async def list_sources(session: AsyncSession, *, user_id: uuid.UUID) -> list[ExternalSource]:
    """등록된 소스 목록. 프리셋 기반 소스는 여기서 최신 버전으로 자동 갱신된다(Task 34 PR5).

    "앱 시작 시" 대신 "목록을 조회할 때" 동기화한다 — 별도 부팅 훅 없이 사용자가 소스
    화면을 열 때마다(가장 흔한 진입점) 최신 상태를 보게 된다는 점에서 더 낫다.
    """
    sources = list(
        await session.scalars(
            select(ExternalSource)
            .where(ExternalSource.user_id == user_id, ExternalSource.deleted_at.is_(None))
            .order_by(ExternalSource.priority, ExternalSource.name)
        )
    )
    for source in sources:
        if _sync_preset_if_stale(source):
            from sooljang.application.provider_connections import source_configuration_changed

            await source_configuration_changed(session, source)
    await session.flush()
    return sources


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
    price_history_allowed: bool = False,
    rate_limit_per_min: int = 6,
    request_limit_per_day: int = 1000,
    ttl_hours: int = 24,
    note: str | None = None,
) -> ExternalSource:
    """커스텀 등록(`adapter_spec` JSON 직접 입력). 프리셋 등록은 `create_source_from_preset`."""
    await ensure_category_exists(session, user_id=user_id, category_id=category_id)
    source = ExternalSource(
        user_id=user_id,
        name=name,
        base_url=base_url,
        adapter_spec=adapter_spec,
        category_id=category_id,
        priority=priority,
        is_active=is_active,
        price_history_allowed=price_history_allowed,
        rate_limit_per_min=rate_limit_per_min,
        request_limit_per_day=request_limit_per_day,
        ttl_hours=ttl_hours,
        note=note,
    )
    session.add(source)
    await session.flush()
    from sooljang.application.provider_connections import ensure_source_connection

    await ensure_source_connection(session, source)
    return source


async def create_source_from_preset(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    preset_key: str,
    name: str | None = None,
    category_id: uuid.UUID | None = None,
    priority: int = 0,
    is_active: bool = True,
    price_history_allowed: bool = False,
    rate_limit_per_min: int = 6,
    request_limit_per_day: int = 1000,
    ttl_hours: int = 24,
    note: str | None = None,
) -> ExternalSource:
    """프리셋 카탈로그(`infrastructure/external/presets.py`)에서 소스를 등록한다(Task 34 PR5).

    `adapter_spec`·`base_url` 은 프리셋 값을 그대로 쓴다 — 사용자가 셀렉터 문법을 몰라도
    등록할 수 있게 하는 것이 프리셋의 목적이다. 이름은 원하면 바꿀 수 있다.
    """
    preset = get_preset(preset_key)
    if preset is None:
        raise NotFoundError(f"프리셋을 찾을 수 없습니다: {preset_key}")

    await ensure_category_exists(session, user_id=user_id, category_id=category_id)
    source = ExternalSource(
        user_id=user_id,
        name=name or preset.name,
        base_url=preset.base_url,
        adapter_spec=preset.adapter_spec,
        category_id=category_id,
        priority=priority,
        is_active=is_active,
        price_history_allowed=price_history_allowed,
        rate_limit_per_min=rate_limit_per_min,
        request_limit_per_day=request_limit_per_day,
        ttl_hours=ttl_hours,
        note=note,
        preset_key=preset.key,
        preset_version=preset.version,
        spec_overridden=False,
    )
    session.add(source)
    await session.flush()
    from sooljang.application.provider_connections import ensure_source_connection

    await ensure_source_connection(session, source)
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
    # 프리셋으로 등록한 소스를 사용자가 직접 고치면, 앱 업데이트로 인한 자동 갱신 대상에서
    # 뺀다(Task 34 PR5) — 그러지 않으면 다음 프리셋 버전 갱신이 사용자 편집을 덮어쓴다.
    editing_spec = "adapter_spec" in fields and "spec_overridden" not in fields
    if editing_spec and source.preset_key is not None:
        fields["spec_overridden"] = True
    changed = any(getattr(source, key) != value for key, value in fields.items())
    for key, value in fields.items():
        setattr(source, key, value)
    if changed:
        source.config_revision += 1
        from sooljang.application.provider_connections import source_configuration_changed

        await source_configuration_changed(session, source)
    await session.flush()
    return source


async def delete_source(session: AsyncSession, source: ExternalSource) -> None:
    source.deleted_at = datetime.now(UTC)


# --- 자격 증명 (Task 34 PR5) ---------------------------------------------------

#: 마스킹 시 보여줄 꼬리 글자 수. `application/llm_settings.py::_VISIBLE_SUFFIX` 와 같다.
_CREDENTIAL_VISIBLE_SUFFIX = 4


def _credential_hint(value: str) -> str:
    if len(value) >= _CREDENTIAL_VISIBLE_SUFFIX:
        return value[-_CREDENTIAL_VISIBLE_SUFFIX:]
    return value


async def set_credentials(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source_id: uuid.UUID,
    values: dict[str, str],
    master_key: str,
) -> dict[str, str]:
    """소스의 자격 증명을 일괄 저장한다(있으면 덮어쓴다).

    반환값은 마스킹된 힌트뿐이다 — 원문은 이 함수를 벗어나지 않는다(`LlmSetting` 과 같은
    Fernet 패턴, `infrastructure/security/secrets.py`).
    """
    source = await get_owned_source(session, user_id=user_id, source_id=source_id)
    if source is None:
        raise NotFoundError("외부 소스를 찾을 수 없습니다")
    hints: dict[str, str] = {}
    for name, value in values.items():
        if not value.strip():
            continue
        ciphertext = encrypt_secret(value, master_key=master_key)
        hint = _credential_hint(value)
        existing = await session.scalar(
            select(ExternalSourceCredential).where(
                ExternalSourceCredential.source_id == source_id,
                ExternalSourceCredential.name == name,
                ExternalSourceCredential.deleted_at.is_(None),
            )
        )
        if existing is None:
            session.add(
                ExternalSourceCredential(
                    user_id=user_id,
                    source_id=source_id,
                    name=name,
                    secret_ciphertext=ciphertext,
                    hint=hint,
                )
            )
        else:
            existing.secret_ciphertext = ciphertext
            existing.hint = hint
        hints[name] = hint
    if hints:
        source = await get_owned_source(session, user_id=user_id, source_id=source_id)
        if source is None:
            raise NotFoundError("외부 소스를 찾을 수 없습니다")
        source.config_revision += 1
    await session.flush()
    from sooljang.application.provider_connections import sync_legacy_source_credentials

    await sync_legacy_source_credentials(session, source)
    return hints


async def get_credential_hints(session: AsyncSession, *, source_id: uuid.UUID) -> dict[str, str]:
    """저장된 자격 증명의 이름→마스킹 힌트. 원문은 절대 포함하지 않는다."""
    rows = await session.scalars(
        select(ExternalSourceCredential).where(
            ExternalSourceCredential.source_id == source_id,
            ExternalSourceCredential.deleted_at.is_(None),
        )
    )
    return {row.name: row.hint for row in rows}


async def _load_credential_values(
    session: AsyncSession, *, source_id: uuid.UUID, master_key: str
) -> dict[str, str]:
    """복호화된 자격 증명 값. `fetch_snapshot` 호출 직전에만 쓰고, 반환값을 API 응답
    스키마·로그·에러 메시지 어디에도 담지 않는다."""
    rows = await session.scalars(
        select(ExternalSourceCredential).where(
            ExternalSourceCredential.source_id == source_id,
            ExternalSourceCredential.deleted_at.is_(None),
        )
    )
    return {row.name: decrypt_secret(row.secret_ciphertext, master_key=master_key) for row in rows}


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
    external_product_key: str | None = None,
    preferred_seller_key: str | None = None,
) -> ExternalProductMatch:
    """ "이 제품 = 이 소스의 이 상품" 을 확정한다. 이미 있으면 덮어쓴다."""
    if not is_same_host(source.base_url, external_url):
        raise PinHostMismatchError(
            f"고정 대상 URL 이 소스의 주소와 다른 호스트입니다: {external_url}"
        )

    await load_product(session, user_id=user_id, product_id=product_id, for_update=True)
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
            external_product_key=external_product_key,
            preferred_seller_key=preferred_seller_key,
        )
        session.add(match)
    else:
        match.external_url = external_url
        match.external_name = external_name
        match.external_key = external_key
        match.confirmed_at = confirmed_at
        match.external_product_key = external_product_key
        match.preferred_seller_key = preferred_seller_key

    await _purge_cache(session, source_id=source.id, product_id=product_id)
    await session.flush()
    return match


async def unpin_match(
    session: AsyncSession, *, source_id: uuid.UUID, product_id: uuid.UUID
) -> bool:
    """고정을 해제한다. 해제할 것이 없었으면 `False`."""
    await session.execute(select(Product.id).where(Product.id == product_id).with_for_update())
    match = await get_match(session, source_id=source_id, product_id=product_id)
    if match is None:
        return False
    match.deleted_at = datetime.now(UTC)
    await _purge_cache(session, source_id=source_id, product_id=product_id)
    await session.flush()
    return True


# --- 소스 헬스 체크 (Task 34 PR4) ----------------------------------------------

#: 소스별로 유지할 최근 시도 기록 개수(롤링 로그). 헬스 판정에 필요한 것보다 넉넉히
#: 잡아 뒀다 — 화면에서 최근 이력을 몇 개 더 보여주고 싶어져도 여유가 있게.
PROBE_HISTORY_LIMIT = 20
#: 가장 최근 시도부터 연속 실패가 이 값 이상이면 헬스를 "failing" 으로 본다.
FAILING_THRESHOLD = 3


@dataclass(frozen=True, slots=True)
class SourceHealth:
    """소스 하나의 최근 조회 이력 요약."""

    source_id: uuid.UUID
    source_name: str
    #: "healthy"(정상) | "degraded"(부분 실패) | "failing"(연속 실패) | "unknown"(이력 없음)
    status: str
    last_success_at: datetime | None
    #: 가장 최근 시도부터 센 연속 실패 횟수. 성공이 하나라도 나오면 거기서 멈춘다.
    consecutive_failures: int
    last_warning: str | None
    config_revision: int = 1
    last_attempt_at: datetime | None = None
    last_outcome: str = "unknown"
    verification_stale: bool = False
    reserved_requests_today: int = 0


@dataclass(frozen=True, slots=True)
class ProbeResult:
    """`probe_source` 한 번의 결과. 캐시에는 안 남기고 헬스 로그에만 기록한다."""

    ok: bool
    degraded: bool
    warning: str | None
    matched_name: str | None
    match_score: float | None
    outcome: SourceOutcome = SourceOutcome.UNKNOWN


async def _trim_probes(session: AsyncSession, *, source_id: uuid.UUID) -> None:
    """소스별 최근 `PROBE_HISTORY_LIMIT` 개만 남기고 오래된 시도 기록을 지운다."""
    stale_ids = list(
        await session.scalars(
            select(ExternalSourceProbe.id)
            .where(ExternalSourceProbe.source_id == source_id)
            .order_by(ExternalSourceProbe.attempted_at.desc())
            .offset(PROBE_HISTORY_LIMIT)
        )
    )
    if stale_ids:
        await session.execute(
            delete(ExternalSourceProbe).where(ExternalSourceProbe.id.in_(stale_ids))
        )


async def _record_probe(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source_id: uuid.UUID,
    ok: bool,
    degraded: bool,
    warning: str | None,
    attempted_at: datetime,
    config_revision: int = 1,
    outcome: str = "unknown",
) -> None:
    """소스에 실제로 조회를 시도한 결과 하나를 헬스 로그에 남긴다.

    `external_lookup_cache` 는 성공한 조회만 담아(절대 규칙 7) 실패 이력이 남는 곳이
    없었다. 캐시 적중은 실제 시도가 아니므로 여기 기록하지 않는다 — 사이트가 지금
    살아 있는지를 보려는 것이지, 캐시 재사용 빈도를 보려는 게 아니다.
    """
    session.add(
        ExternalSourceProbe(
            user_id=user_id,
            source_id=source_id,
            attempted_at=attempted_at,
            config_revision=config_revision,
            outcome=outcome,
            ok=ok,
            degraded=degraded,
            warning=warning,
        )
    )
    await session.flush()
    await _trim_probes(session, source_id=source_id)
    await session.flush()


def _summarize_health(source: ExternalSource, probes: list[ExternalSourceProbe]) -> SourceHealth:
    """최근 시도 기록(최신순)에서 헬스 상태를 계산한다."""
    if not probes:
        return SourceHealth(
            source_id=source.id,
            source_name=source.name,
            status="unknown",
            last_success_at=None,
            consecutive_failures=0,
            last_warning=None,
            config_revision=source.config_revision,
        )

    consecutive_failures = 0
    for probe in probes:
        if probe.config_revision != source.config_revision or probe.ok:
            break
        consecutive_failures += 1

    last_success_at = next((probe.attempted_at for probe in probes if probe.ok), None)
    latest = probes[0]

    stale = latest.config_revision != source.config_revision
    if stale:
        status = "unknown"
    elif consecutive_failures >= FAILING_THRESHOLD:
        status = "failing"
    elif not latest.ok or latest.degraded:
        status = "degraded"
    else:
        status = "healthy"

    return SourceHealth(
        source_id=source.id,
        source_name=source.name,
        status=status,
        last_success_at=last_success_at,
        consecutive_failures=consecutive_failures,
        last_warning=latest.warning,
        config_revision=source.config_revision,
        last_attempt_at=latest.attempted_at,
        last_outcome=latest.outcome,
        verification_stale=stale,
    )


async def get_health(session: AsyncSession, *, user_id: uuid.UUID) -> list[SourceHealth]:
    """사용자가 등록한 소스마다 최근 이력을 요약한다. 등록 순서를 그대로 따른다."""
    sources = await list_sources(session, user_id=user_id)
    results: list[SourceHealth] = []
    for source in sources:
        probes = list(
            await session.scalars(
                select(ExternalSourceProbe)
                .where(ExternalSourceProbe.source_id == source.id)
                .order_by(ExternalSourceProbe.attempted_at.desc())
                .limit(PROBE_HISTORY_LIMIT)
            )
        )
        health = _summarize_health(source, probes)
        usage = await current_usage(
            session, user_id=user_id, scope_kind="source", scope_id=source.id
        )
        results.append(replace(health, reserved_requests_today=usage["day"]))
    return results


async def _fetch_source(
    session: AsyncSession,
    *,
    source: ExternalSource,
    identity: ProductIdentity,
    transport: httpx.AsyncBaseTransport | None,
    master_key: str | None,
    pinned: PinnedMatch | None = None,
    allow_paused: bool = False,
) -> AdapterResult:
    from sooljang.application.provider_connections import (
        ConnectionChanged,
        get_owned_connection,
        get_request_credentials,
        reserve_connection_request,
        validate_source_connection,
    )

    connection = None
    try:
        if source.connection_id is not None:
            connection = await get_owned_connection(
                session, user_id=source.user_id, connection_id=source.connection_id
            )
            await validate_source_connection(session, source, connection)
            values = await get_request_credentials(
                session,
                user_id=source.user_id,
                connection_id=connection.id,
                master_key=master_key or "",
                require_active=not allow_paused,
            )
        else:
            values = (
                await _load_credential_values(session, source_id=source.id, master_key=master_key)
                if master_key is not None
                else {}
            )
    except ConnectionChanged:
        return AdapterResult(
            None,
            {},
            None,
            True,
            "연결 사용이 일시 중지되었습니다",
            outcome=SourceOutcome.INVALID_CONFIGURATION,
        )
    except NotFoundError:
        return AdapterResult(
            None,
            {},
            None,
            True,
            "소스에 연결된 인증 설정이 해제되었습니다",
            outcome=SourceOutcome.CREDENTIAL_UNAVAILABLE,
        )
    except ValidationFailedError:
        return AdapterResult(
            None,
            {},
            None,
            True,
            "소스와 제공자의 인증 대상이 일치하지 않습니다",
            outcome=SourceOutcome.INVALID_CONFIGURATION,
        )
    except InvalidToken, ValueError:
        return AdapterResult(
            None,
            {},
            None,
            True,
            "저장된 자격증명을 복호화할 수 없습니다",
            outcome=SourceOutcome.CREDENTIAL_UNAVAILABLE,
        )
    entries = source.adapter_spec.get("credentials", [])
    if isinstance(entries, list) and any(
        isinstance(entry, dict)
        and isinstance(entry.get("name"), str)
        and not values.get(entry["name"])
        for entry in entries
    ):
        return AdapterResult(
            None,
            {},
            None,
            True,
            "필요한 API 자격증명을 등록해 주세요",
            outcome=SourceOutcome.CREDENTIAL_UNAVAILABLE,
        )

    async def before_request(_request: httpx.Request) -> None:
        if connection is not None:
            await reserve_connection_request(
                session,
                user_id=source.user_id,
                connection_id=connection.id,
                expected_revision=connection.config_revision,
                require_active=not allow_paused,
                source_id=source.id,
                source_revision=source.config_revision,
            )
            return
        await reserve_request(
            user_id=source.user_id,
            budgets=[
                RequestBudget(
                    "source", source.id, source.rate_limit_per_min, source.request_limit_per_day
                )
            ],
        )

    source_revision = source.config_revision
    connection_revision = connection.config_revision if connection is not None else None

    async def check_configuration(_request: httpx.Request) -> None:
        if connection is not None:
            await reserve_connection_request(
                session,
                user_id=source.user_id,
                connection_id=connection.id,
                expected_revision=connection_revision or 0,
                require_active=not allow_paused,
                source_id=source.id,
                source_revision=source_revision,
                reserve=False,
            )
        else:
            current = (
                await session.execute(
                    select(ExternalSource.config_revision, ExternalSource.is_active).where(
                        ExternalSource.id == source.id,
                        ExternalSource.user_id == source.user_id,
                        ExternalSource.deleted_at.is_(None),
                    )
                )
            ).first()
            if (
                current is None
                or current[0] != source_revision
                or (not allow_paused and not current[1])
            ):
                raise ConnectionChanged("요청 중 소스 설정이 바뀌었습니다")

    with outbound_guard(check_configuration):
        return await fetch_snapshot(
            source.adapter_spec,
            base_url=source.base_url,
            identity=identity,
            transport=transport,
            pinned=pinned,
            credentials=values or None,
            before_request=before_request,
        )


async def probe_source(
    session: AsyncSession,
    *,
    source: ExternalSource,
    sample_name: str,
    transport: httpx.AsyncBaseTransport | None = None,
    master_key: str | None = None,
) -> ProbeResult:
    """샘플 제품명으로 소스를 테스트 조회한다.

    실제로 소유한 제품이 아니므로 `external_lookup_cache` 에는 저장하지 않는다 —
    이 결과가 다른 조회에 섞여 들어가면 안 된다. 대신 헬스 로그에는 남긴다. 이 함수가
    바로 그 소스에 지금 무슨 일이 있는지 확인하는 유일한 온디맨드 수단이라, 여기서
    기록하지 않으면 사용자가 "테스트 조회" 를 눌러도 헬스 화면에 반영되지 않는다.

    `master_key` 가 있으면 저장된 자격 증명을 복호화해 함께 전달한다(Task 34 PR5) — 자격
    증명이 필요한 소스도 실제 요청이 나가는 모양 그대로 테스트할 수 있어야 한다.
    """
    identity = ProductIdentity(
        name=sample_name,
        name_en=None,
        producer=None,
        abv=None,
        vintage=None,
        age_years=None,
        volumes_ml=(),
    )
    result = await _fetch_source(
        session,
        source=source,
        identity=identity,
        transport=transport,
        master_key=master_key,
        allow_paused=True,
    )
    await _record_probe(
        session,
        user_id=source.user_id,
        source_id=source.id,
        ok=result.ok,
        config_revision=source.config_revision,
        outcome=result.outcome,
        degraded=result.degraded,
        warning=result.warning,
        attempted_at=datetime.now(UTC),
    )
    return ProbeResult(
        ok=result.ok,
        degraded=result.degraded,
        warning=result.warning,
        matched_name=result.matched_name,
        match_score=result.match_score,
        outcome=result.outcome,
    )


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
    #: 표준 키로 분류하고 파생값(정규화 평점·100ml당 가격)을 계산한 결과(Task 34 PR3).
    #: `fields` 원본은 위에 그대로 남아 있다 — 이 값은 매 응답마다 다시 계산되고 저장되지
    #: 않는다(절대 규칙 6).
    normalized: NormalizedFields = field(default_factory=NormalizedFields)
    #: LLM 이 애매 구간에서 추천한 후보의 URL(Task 34 PR6). `candidates` 안의 항목 중
    #: 하나를 가리킨다 — 화면이 "LLM 추천" 배지를 붙이는 용도일 뿐, 자동으로 고정되지
    #: 않는다(여전히 사용자가 "이걸로 고정" 을 눌러야 한다).
    llm_recommended_url: str | None = None
    outcome: SourceOutcome = SourceOutcome.UNKNOWN
    offers: list[dict[str, Any]] = field(default_factory=list)
    product_key: str | None = None
    preferred_seller_key: str | None = None
    configuration_revision: int | None = None


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
    # 버전이 낮은 스냅샷(표준 키 도입 이전)은 TTL 이 안 지났어도 stale 로 본다 — `fields`
    # 가 옛 자유 dict 모양이라 비교 뷰가 값을 못 잡는다. 다음 조회가 새로 채운다.
    if cached.snapshot.get("version", 1) < SNAPSHOT_VERSION:
        return None
    if cached.snapshot.get("config_revision") != source.config_revision:
        return None
    return cached


async def _build_identity(session: AsyncSession, product: Product) -> ProductIdentity:
    """매칭에 쓸 제품 식별 정보를 모은다(Task 34 PR2).

    Task 18 은 `product.name` 하나만 넘겼다 — 나머지 필드가 스키마에 있는데도 놀았다.
    SKU 용량은 `Sku` 를 직접 조회한다(`product.skus` 는 lazy 라 여기서 만지면 비동기
    컨텍스트에서 터진다).
    """
    volumes = await session.scalars(
        select(Sku.volume_ml).where(Sku.product_id == product.id, Sku.deleted_at.is_(None))
    )
    producer = product.producer.name if product.producer is not None else None
    return ProductIdentity(
        name=product.name,
        name_en=product.name_en,
        producer=producer,
        abv=product.abv,
        vintage=product.vintage,
        age_years=product.age_years,
        volumes_ml=tuple(sorted(set(volumes))),
    )


#: 비용 가드 로그를 이 기간보다 오래 남겨 두지 않는다(Task 34 PR6). 월 집계는 이번 달
#: 시작 시점부터만 세므로, 그보다 넉넉히 긴 기간이면 안전하다.
_REMATCH_LOG_RETENTION_DAYS = 35


def _month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def _rematch_recently_called(
    session: AsyncSession, *, source_id: uuid.UUID, product_id: uuid.UUID, now: datetime
) -> bool:
    """같은 (소스, 제품) 조합을 24시간 안에 이미 호출했는지."""
    cutoff = now - timedelta(hours=24)
    row = await session.scalar(
        select(ExternalLlmRematchLog.id)
        .where(
            ExternalLlmRematchLog.source_id == source_id,
            ExternalLlmRematchLog.product_id == product_id,
            ExternalLlmRematchLog.called_at >= cutoff,
        )
        .limit(1)
    )
    return row is not None


async def _rematch_calls_this_month(
    session: AsyncSession, *, user_id: uuid.UUID, now: datetime
) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(ExternalLlmRematchLog)
        .where(
            ExternalLlmRematchLog.user_id == user_id,
            ExternalLlmRematchLog.called_at >= _month_start(now),
        )
    )
    return count or 0


async def _trim_rematch_log(session: AsyncSession, *, user_id: uuid.UUID, now: datetime) -> None:
    cutoff = now - timedelta(days=_REMATCH_LOG_RETENTION_DAYS)
    await session.execute(
        delete(ExternalLlmRematchLog).where(
            ExternalLlmRematchLog.user_id == user_id, ExternalLlmRematchLog.called_at < cutoff
        )
    )


async def _record_rematch_call(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source_id: uuid.UUID,
    product_id: uuid.UUID,
    called_at: datetime,
) -> None:
    """호출을 실제로 시도한 시점에 남긴다(성공/실패 무관) — 실패해도 24시간 안에 같은
    조합을 계속 재호출하며 비용을 쓰지 않게 하려는 목적이다."""
    session.add(
        ExternalLlmRematchLog(
            user_id=user_id, source_id=source_id, product_id=product_id, called_at=called_at
        )
    )
    await session.flush()
    await _trim_rematch_log(session, user_id=user_id, now=called_at)
    await session.flush()


async def _maybe_llm_rematch(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source_id: uuid.UUID,
    product_id: uuid.UUID,
    identity: ProductIdentity,
    candidates: list[LookupCandidate],
    master_key: str | None,
    now: datetime,
) -> str | None:
    """조건이 전부 맞으면 LLM 에 애매 구간 재판정을 묻는다. 아니면 조용히 `None`(Task 34
    PR6) — 호출 여부를 정하는 것이 이 함수의 역할이고, 실제 호출·실패 처리는
    `match_llm.rematch` 의 계약을 그대로 따른다(예외를 내보내지 않는다).

    호출 조건 전부: ① `master_key` 로 설정을 복호화할 수 있음 ② `LlmSetting` 활성
    ③ 사용자가 "LLM 매칭 보조"를 켬(기본 꺼짐) ④ 같은 (소스, 제품) 조합을 24시간 안에
    호출하지 않았음 ⑤ 이번 달 호출 수가 상한 미만.
    """
    if master_key is None or not candidates:
        return None

    setting = await get_llm_setting(session, user_id=user_id)
    if setting is None or not setting.rematch_enabled:
        return None

    if await _rematch_recently_called(session, source_id=source_id, product_id=product_id, now=now):
        return None
    calls_this_month = await _rematch_calls_this_month(session, user_id=user_id, now=now)
    if calls_this_month >= setting.rematch_monthly_cap:
        return None

    from sooljang.application.llm_settings import get_decrypted_api_key

    try:
        configured = await get_decrypted_api_key(
            session, user_id=user_id, master_key=master_key, reserve=True
        )
    except Exception:
        return None
    if configured is None:
        return None
    _, api_key, model = configured
    await _record_rematch_call(
        session, user_id=user_id, source_id=source_id, product_id=product_id, called_at=now
    )

    outcome = await llm_rematch(
        identity,
        [candidate.name for candidate in candidates],
        api_key=api_key,
        model=model,
    )
    if outcome is None or outcome.index is None:
        return None
    return candidates[outcome.index].url


_MATCH_STATE_FIELDS = (
    "id",
    "external_url",
    "external_key",
    "external_name",
    "external_product_key",
    "preferred_seller_key",
    "confirmed_at",
)


def _match_state(match: ExternalProductMatch | None) -> tuple[Any, ...] | None:
    return tuple(getattr(match, name) for name in _MATCH_STATE_FIELDS) if match else None


async def _lookup_target_current(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    product: Product,
    source: ExternalSource,
    product_revision: datetime,
    match_state: tuple[Any, ...] | None,
    connection_revision: int | None,
) -> bool:
    # 읽기 대상은 SHARE 잠금으로 설정 변경을 막는다. FK의 KEY SHARE와 호환되어
    # 동시에 새 pin을 만드는 Product→source FK 순서와 교착하지 않는다.
    if source.connection_id:
        connection = (
            await session.execute(
                select(ProviderConnection.config_revision, ProviderConnection.is_active)
                .where(
                    ProviderConnection.id == source.connection_id,
                    ProviderConnection.user_id == user_id,
                    ProviderConnection.deleted_at.is_(None),
                )
                .with_for_update(read=True)
            )
        ).first()
        if connection is None or connection[0] != connection_revision or not connection[1]:
            return False
    current_source = (
        await session.execute(
            select(
                ExternalSource.config_revision,
                ExternalSource.is_active,
                ExternalSource.price_history_allowed,
            )
            .where(
                ExternalSource.id == source.id,
                ExternalSource.user_id == user_id,
                ExternalSource.deleted_at.is_(None),
            )
            .with_for_update(read=True)
        )
    ).first()
    if (
        current_source is None
        or current_source[0] != source.config_revision
        or not current_source[1]
        or current_source[2] != source.price_history_allowed
    ):
        return False
    current_product = await session.scalar(
        select(Product.updated_at)
        .where(Product.id == product.id, Product.user_id == user_id, Product.deleted_at.is_(None))
        .with_for_update()
    )
    if current_product != product_revision:
        return False
    current_match = (
        await session.execute(
            select(*(getattr(ExternalProductMatch, name) for name in _MATCH_STATE_FIELDS)).where(
                ExternalProductMatch.source_id == source.id,
                ExternalProductMatch.product_id == product.id,
                ExternalProductMatch.deleted_at.is_(None),
            )
        )
    ).first()
    return (tuple(current_match) if current_match else None) == match_state


def _changed_lookup(source: ExternalSource) -> SourceLookupResult:
    return SourceLookupResult(
        source.id,
        source.name,
        False,
        None,
        {},
        None,
        True,
        "조회 중 제품·고정 또는 소스 설정이 바뀌어 이전 결과를 폐기했습니다",
        None,
        outcome=SourceOutcome.INVALID_CONFIGURATION,
    )


async def lookup_product(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    product: Product,
    transport: httpx.AsyncBaseTransport | None = None,
    master_key: str | None = None,
    allow_llm: bool = True,
    source_ids: list[uuid.UUID] | None = None,
) -> list[SourceLookupResult]:
    """제품 이름으로 등록된 소스들을 조회한다. 사용자 조작(버튼 클릭)에서만 호출해야 한다.

    소스별로 독립적으로 시도한다 — 하나가 실패하거나 rate limit 에 걸려도 나머지는 계속
    진행한다. 결과가 없는 소스도 `degraded=True` 항목으로 포함해 사용자에게 "왜 안 나왔는지"
    보여준다.

    `master_key` 가 있으면 소스별로 저장된 자격 증명을 복호화해 조회에 함께 쓴다(Task 34
    PR5). 캐시 적중 경로는 자격 증명이 필요 없다 — 이미 성공한 값을 그대로 돌려줄 뿐이다.
    같은 `master_key` 로 `LlmSetting` 의 API 키도 복호화해, 애매 구간에서 사용자가 "LLM
    매칭 보조"를 켜 뒀으면 재판정을 시도한다(Task 34 PR6, `_maybe_llm_rematch`).
    """
    # 호출자가 같은 트랜잭션에서 제품을 수정했다면 서버 갱신 시각을 비동기로 읽는다.
    # identity와 revision은 같은 최신 행에서 가져온다.
    await session.flush()
    await session.refresh(product)
    product_revision = product.updated_at
    identity = await _build_identity(session, product)
    sources = await session.scalars(
        select(ExternalSource)
        .where(
            ExternalSource.user_id == user_id,
            ExternalSource.deleted_at.is_(None),
            ExternalSource.is_active.is_(True),
            ExternalSource.id.in_(source_ids) if source_ids is not None else true(),
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
        expected_match = _match_state(match)
        connection_revision = (
            await session.scalar(
                select(ProviderConnection.config_revision).where(
                    ProviderConnection.id == source.connection_id
                )
            )
            if source.connection_id
            else None
        )
        pinned = (
            PinnedMatch(
                external_url=match.external_url,
                external_key=match.external_key,
                product_key=match.external_product_key,
                external_name=match.external_name,
            )
            if match is not None
            else None
        )

        cached = await _fresh_cache(session, source=source, product_id=product.id)
        if cached is not None:
            if not await _lookup_target_current(
                session,
                user_id=user_id,
                product=product,
                source=source,
                product_revision=product_revision,
                match_state=expected_match,
                connection_revision=connection_revision,
            ):
                results.append(_changed_lookup(source))
                continue
            cached_offers = []
            for facts in cached.snapshot.get("offers", []):
                rebuilt = prepare_offer(
                    product_key=facts["product_key"],
                    offer_key=facts["offer_key"],
                    name=facts["name"],
                    url=facts["source_url"],
                    fields=facts,
                    identity=identity,
                    confirmed=pinned is not None
                    or not cached.snapshot.get("needs_confirmation", True),
                )
                if rebuilt is not None:
                    rebuilt["fetched_at"] = cached.fetched_at.isoformat()
                    cached_offers.append(rebuilt)
            cached_fields = cached.snapshot.get("fields", {})
            results.append(
                SourceLookupResult(
                    source_id=source.id,
                    source_name=source.name,
                    cached=True,
                    offers=cached_offers,
                    preferred_seller_key=match.preferred_seller_key if match is not None else None,
                    product_key=cached.snapshot.get("product_key"),
                    needs_confirmation=cached.snapshot.get("needs_confirmation", True),
                    outcome=SourceOutcome.PARTIAL if cached.degraded else SourceOutcome.SUCCESS,
                    source_url=cached.snapshot.get("source_url"),
                    fields=cached_fields,
                    raw_excerpt=cached.snapshot.get("raw_excerpt"),
                    degraded=cached.degraded,
                    warning=cached.warning,
                    fetched_at=cached.fetched_at,
                    matched_name=cached.snapshot.get("matched_name"),
                    match_score=cached.snapshot.get("match_score"),
                    pinned=pinned is not None,
                    normalized=split_fields(cached_fields),
                )
            )
            continue

        adapter_result = await _fetch_source(
            session,
            source=source,
            identity=identity,
            transport=transport,
            pinned=pinned,
            master_key=master_key,
        )
        fetched_at = datetime.now(UTC)
        if not await _lookup_target_current(
            session,
            user_id=user_id,
            product=product,
            source=source,
            product_revision=product_revision,
            match_state=expected_match,
            connection_revision=connection_revision,
        ):
            results.append(_changed_lookup(source))
            continue

        # 절대 규칙(§7.1): 출처 URL 이 없는 결과는 캐시에 저장하지 않는다. `ok` 도 함께
        # 확인한다 — 상세 페이지 조회 자체가 실패해도 `source_url` 은 채워져 있을 수
        # 있는데(어느 URL 을 시도했는지는 남긴다), 그 실패를 성공인 것처럼 TTL 동안
        # 캐시해 버리면 다음 조회도 계속 빈 결과만 돌려주게 된다. 매번 새로 시도하도록
        # 두되(다음 조회에서 다시 시도할 기회를 준다), 화면에는 이번 결과만 보여준다.
        if adapter_result.ok and adapter_result.source_url is not None:
            # 기존 고정은 원래 판매 항목을 실제로 다시 찾은 경우에만 제품 identity로 연결한다.
            if (
                match is not None
                and match.external_product_key is None
                and adapter_result.product_key
            ):
                match.external_product_key = adapter_result.product_key
            adapter_result.offers = [
                {**offer, "fetched_at": fetched_at.isoformat()} for offer in adapter_result.offers
            ]
            if source.price_history_allowed:
                adapter_result.offers = await record_offers(
                    session,
                    user_id=user_id,
                    source_id=source.id,
                    product_id=product.id,
                    fetched_at=fetched_at,
                    offers=adapter_result.offers,
                )
            if source.price_history_allowed or not adapter_result.offers:
                session.add(
                    ExternalLookupCache(
                        user_id=user_id,
                        source_id=source.id,
                        product_id=product.id,
                        snapshot={
                            "version": SNAPSHOT_VERSION,
                            "config_revision": source.config_revision,
                            "source_url": adapter_result.source_url,
                            "fields": adapter_result.fields,
                            "raw_excerpt": adapter_result.raw_excerpt,
                            "matched_name": adapter_result.matched_name,
                            "match_score": adapter_result.match_score,
                            "external_key": adapter_result.matched_key,
                            "product_key": adapter_result.product_key,
                            "needs_confirmation": adapter_result.needs_confirmation,
                            "offers": [raw_offer(offer) for offer in adapter_result.offers],
                        },
                        degraded=adapter_result.degraded,
                        warning=adapter_result.warning,
                        fetched_at=fetched_at,
                    )
                )
                await session.flush()

        if not adapter_result.ok and source.price_history_allowed:
            adapter_result.offers = await last_observed_offers(
                session,
                user_id=user_id,
                source_id=source.id,
                product_id=product.id,
                identity=identity,
                pinned_product_key=pinned.product_key if pinned is not None else None,
            )

        # 실제 시도였으니 헬스 로그에 남긴다(캐시 적중·rate limit 스킵은 시도가 아니라
        # 위 두 continue 에서 이미 걸러졌다).
        await _record_probe(
            session,
            user_id=user_id,
            source_id=source.id,
            ok=adapter_result.ok,
            config_revision=source.config_revision,
            outcome=adapter_result.outcome,
            degraded=adapter_result.degraded,
            warning=adapter_result.warning,
            attempted_at=fetched_at,
        )

        # 애매 구간(0.5~0.85)에서만, 그리고 사용자가 "LLM 매칭 보조"를 명시적으로 켰을
        # 때만 물어본다(Task 34 PR6). 캐시 적중 경로는 후보 목록 자체가 없어 대상이 아니다.
        llm_recommended_url = None
        if allow_llm and adapter_result.needs_confirmation:
            llm_recommended_url = await _maybe_llm_rematch(
                session,
                user_id=user_id,
                source_id=source.id,
                product_id=product.id,
                identity=identity,
                candidates=adapter_result.candidates,
                master_key=master_key,
                now=fetched_at,
            )

        results.append(
            SourceLookupResult(
                source_id=source.id,
                source_name=source.name,
                cached=False,
                offers=adapter_result.offers,
                preferred_seller_key=match.preferred_seller_key if match is not None else None,
                product_key=adapter_result.product_key,
                outcome=adapter_result.outcome,
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
                normalized=split_fields(adapter_result.fields),
                llm_recommended_url=llm_recommended_url,
            )
        )

    return results
