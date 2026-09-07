"""독립 DB 세션을 쓰는 일정/lease/알림/전달의 동시 실행과 재시작 회귀."""

import asyncio
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from sooljang.application.external_sources import SourceLookupResult
from sooljang.application.price_watch_worker import (
    _run_guard,
    claim_delivery,
    claim_run,
    deliver_push,
    enqueue_due,
    process_results,
)
from sooljang.application.provider_connections import ConnectionChanged
from sooljang.config import get_settings
from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.database.models.price_watch import (
    PriceNotification,
    PriceWatch,
    PriceWatchRun,
    PushDelivery,
    PushSubscription,
)
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_price_watch import FACTS, create, seed
from tests.infrastructure.test_web_push import PRIVATE, subscription


def run_async(client: TestClient, function: Any) -> Any:
    assert client.portal is not None
    return client.portal.call(function)


def result_for(data: dict[str, Any], **changes: Any) -> SourceLookupResult:
    return SourceLookupResult(
        source_id=data["source_id"],
        source_name="합성 가격 소스",
        cached=False,
        source_url=FACTS["source_url"],
        fields={},
        raw_excerpt=None,
        degraded=False,
        warning=None,
        fetched_at=data["fetched_at"],
        pinned=True,
        outcome=SourceOutcome.SUCCESS,
        offers=data["offers"],
        **changes,
    )


def enqueue(client: TestClient, prefix: str, watch: dict[str, Any]) -> None:
    response = client.post(
        f"{prefix}/price-watch/{watch['id']}/check",
        json={"expected_revision": watch["config_revision"], "request_id": str(uuid.uuid4())},
    )
    assert response.status_code == 202, response.text


def test_two_schedulers_coalesce_missed_occurrences_and_two_workers_claim_once(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)

    async def exercise() -> None:
        now = datetime.now(UTC)
        async with get_session_factory().begin() as session:
            row = await session.get(PriceWatch, uuid.UUID(watch["id"]))
            assert row is not None
            row.schedule_enabled = True
            row.interval_seconds = 900
            row.next_due_at = now - timedelta(days=30)

        async def schedule() -> int:
            async with get_session_factory().begin() as session:
                return await enqueue_due(session, now=now)

        assert sum(await asyncio.gather(schedule(), schedule())) == 1
        assert await schedule() == 0

        async def claim():
            async with get_session_factory().begin() as session:
                return await claim_run(session, now=now)

        claimed = await asyncio.gather(claim(), claim())
        assert sum(item is not None for item in claimed) == 1
        async with get_session_factory()() as session:
            assert await session.scalar(select(func.count()).select_from(PriceWatchRun)) == 1
            row = await session.get(PriceWatch, uuid.UUID(watch["id"]))
            assert row is not None
            assert row.next_due_at is not None and now < row.next_due_at <= now + timedelta(
                minutes=15
            )

    run_async(api_client, exercise)


def test_expired_run_lease_fences_old_requests_and_old_results(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    enqueue(api_client, prefix, watch)

    async def exercise() -> None:
        now = datetime.now(UTC)
        async with get_session_factory().begin() as session:
            old = await claim_run(session, now=now)
            assert old is not None
        async with get_session_factory().begin() as session:
            row = await session.get(PriceWatchRun, old.run_id)
            assert row is not None
            row.lease_until = now - timedelta(seconds=1)
        async with get_session_factory().begin() as session:
            fresh = await claim_run(session, now=now)
            assert fresh is not None and fresh.token != old.token
        with pytest.raises(ConnectionChanged):
            await _run_guard(old, httpx.Request("GET", "https://example.com/"))
        async with get_session_factory().begin() as session:
            await process_results(
                session, lease=old, results=[result_for(data)], now=now, settings=get_settings()
            )
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 0
            await process_results(
                session, lease=fresh, results=[result_for(data)], now=now, settings=get_settings()
            )
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 1

    run_async(api_client, exercise)


def test_pause_during_request_keeps_observation_but_creates_no_notification(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    enqueue(api_client, prefix, watch)

    async def claim():
        async with get_session_factory().begin() as session:
            return await claim_run(session, now=datetime.now(UTC))

    lease = run_async(api_client, claim)
    assert lease is not None
    assert (
        api_client.patch(
            f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 1, "is_active": False}
        ).status_code
        == 200
    )

    async def finish() -> None:
        async with get_session_factory().begin() as session:
            await process_results(
                session,
                lease=lease,
                results=[result_for(data)],
                now=datetime.now(UTC),
                settings=get_settings(),
            )
            row = await session.get(PriceWatchRun, lease.run_id)
            assert row is not None and row.status == "cancelled"
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 0

    run_async(api_client, finish)
    assert (
        len(api_client.get(f"{prefix}/price-watch/interests/{data['interest_id']}/history").json())
        == 1
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"cached": True},
        {"degraded": True},
        {"pinned": False},
        {"outcome": SourceOutcome.PARTIAL},
        {"outcome": SourceOutcome.RATE_LIMITED},
    ],
)
def test_cached_partial_unpinned_or_limited_collection_never_alerts(
    api_client: TestClient, prefix: str, changes: dict[str, Any]
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    enqueue(api_client, prefix, watch)

    async def finish() -> None:
        async with get_session_factory().begin() as session:
            lease = await claim_run(session, now=datetime.now(UTC))
            assert lease is not None
        async with get_session_factory().begin() as session:
            await process_results(
                session,
                lease=lease,
                results=[replace(result_for(data), **changes)],
                now=datetime.now(UTC),
                settings=get_settings(),
            )
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 0

    run_async(api_client, finish)


def prepare_delivery(api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(get_settings(), "push_vapid_private_key", PRIVATE)
    monkeypatch.setattr(get_settings(), "push_vapid_subject", "mailto:admin@example.com")
    info, _, _ = subscription()
    response = api_client.post(f"{prefix}/price-watch/subscriptions", json=info)
    assert response.status_code == 201, response.text
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    watch = api_client.patch(
        f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 1, "push_enabled": True}
    ).json()
    enqueue(api_client, prefix, watch)

    async def process():
        async with get_session_factory().begin() as session:
            run = await claim_run(session, now=datetime.now(UTC))
            assert run is not None
        async with get_session_factory().begin() as session:
            await process_results(
                session,
                lease=run,
                results=[result_for(data)],
                now=datetime.now(UTC),
                settings=get_settings(),
            )
        async with get_session_factory().begin() as session:
            lease = await claim_delivery(session, now=datetime.now(UTC))
            assert lease is not None
            return lease

    return run_async(api_client, process), response.json()["id"]


def test_response_loss_is_not_retried_and_logical_notification_is_preserved(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    lease, _ = prepare_delivery(api_client, prefix, monkeypatch)
    sent = []

    def lost(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        raise httpx.ReadTimeout("synthetic response loss")

    async def exercise() -> None:
        await deliver_push(lease, settings=get_settings(), transport=httpx.MockTransport(lost))
        async with get_session_factory().begin() as session:
            row = await session.get(PushDelivery, lease.delivery_id)
            assert row is not None
            assert row.status == "unknown" and row.attempts == 1
            assert await claim_delivery(session, now=datetime.now(UTC) + timedelta(hours=1)) is None
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 1

    run_async(api_client, exercise)
    assert len(sent) == 1


def test_restart_after_claimed_send_marks_uncertainty_without_resending(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    lease, _ = prepare_delivery(api_client, prefix, monkeypatch)

    async def exercise() -> None:
        async with get_session_factory().begin() as session:
            row = await session.get(PushDelivery, lease.delivery_id)
            assert row is not None
            row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
        async with get_session_factory().begin() as session:
            assert await claim_delivery(session, now=datetime.now(UTC)) is None
            row = await session.get(PushDelivery, lease.delivery_id)
            assert row is not None and row.status == "unknown"

    run_async(api_client, exercise)


def test_expired_subscription_is_disabled_and_ciphertext_discarded(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    lease, subscription_id = prepare_delivery(api_client, prefix, monkeypatch)

    async def exercise() -> None:
        await deliver_push(
            lease,
            settings=get_settings(),
            transport=httpx.MockTransport(lambda _: httpx.Response(410)),
        )
        async with get_session_factory()() as session:
            row = await session.get(PushSubscription, uuid.UUID(subscription_id))
            assert row is not None
            assert not row.is_active and row.subscription_ciphertext is None
            assert row.last_outcome == "expired"

    run_async(api_client, exercise)


def test_definite_429_uses_durable_bounded_retry(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    lease, _ = prepare_delivery(api_client, prefix, monkeypatch)

    async def exercise() -> None:
        await deliver_push(
            lease,
            settings=get_settings(),
            transport=httpx.MockTransport(
                lambda _: httpx.Response(429, headers={"Retry-After": "120"})
            ),
        )
        async with get_session_factory().begin() as session:
            row = await session.get(PushDelivery, lease.delivery_id)
            assert row is not None
            assert row.status == "queued" and row.available_at > datetime.now(UTC) + timedelta(
                seconds=110
            )
            assert await claim_delivery(session, now=datetime.now(UTC)) is None

    run_async(api_client, exercise)


def test_unsubscribe_before_send_stops_transport(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    lease, subscription_id = prepare_delivery(api_client, prefix, monkeypatch)
    assert (
        api_client.delete(f"{prefix}/price-watch/subscriptions/{subscription_id}").status_code
        == 204
    )
    sent = []

    async def exercise() -> None:
        await deliver_push(
            lease,
            settings=get_settings(),
            transport=httpx.MockTransport(
                lambda request: sent.append(request) or httpx.Response(201)
            ),
        )

    run_async(api_client, exercise)
    assert sent == []


def test_real_lookup_pipeline_creates_fresh_history_and_one_alert_without_llm(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from copy import deepcopy
    from unittest.mock import AsyncMock

    from sooljang.application.discovery import lookup_interest
    from sooljang.application.price_watch_worker import execute_run
    from sooljang.infrastructure.database.models import (
        ExternalOffer,
        ExternalPriceObservation,
        ExternalSource,
        Interest,
    )
    from sooljang.infrastructure.external.adapter import reset_robots_cache
    from tests.infrastructure.external.test_offers import ITEMS, SPEC

    reset_robots_cache()
    llm = AsyncMock(side_effect=AssertionError("new lookup must not use LLM"))
    monkeypatch.setattr("sooljang.application.external_sources.llm_rematch", llm)
    owner = uuid.UUID(api_client.get(f"{prefix}/auth/me").json()["id"])
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        return (
            httpx.Response(200, text="User-agent: *\nAllow: /")
            if request.url.path == "/robots.txt"
            else httpx.Response(200, json={"results": ITEMS})
        )

    transport = httpx.MockTransport(respond)

    async def setup() -> dict[str, Any]:
        async with get_session_factory().begin() as session:
            spec = deepcopy(SPEC)
            spec["search"]["offer_fields"]["in_stock"] = {"const": True}
            source = ExternalSource(
                user_id=owner,
                name="실제 경계 합성",
                base_url="https://example.com",
                adapter_spec=spec,
                price_history_allowed=True,
            )
            unrelated = ExternalSource(
                user_id=owner,
                name="선택하지 않은 소스",
                base_url="https://unused.example",
                adapter_spec=spec,
                price_history_allowed=True,
            )
            session.add_all([source, unrelated])
            await session.flush()
            interest = Interest(
                user_id=owner,
                name="Harbor",
                identity={"name": "Harbor 12y 700ml"},
                source_matches={
                    str(source.id): {
                        "product_key": "harbor-12",
                        "external_url": "https://example.com/item/1",
                        "external_key": "1",
                        "external_name": "Harbor 12y 700ml",
                    }
                },
            )
            session.add(interest)
            await session.flush()
            identity = interest.id
            source_id = source.id
        async with get_session_factory().begin() as session:
            results = await lookup_interest(
                session,
                user_id=owner,
                interest_id=identity,
                master_key=get_settings().secret_key,
                source_ids=[source_id],
                transport=transport,
            )
            assert len(results) == 1 and results[0].outcome == SourceOutcome.SUCCESS
            offer = await session.scalar(
                select(ExternalOffer)
                .where(ExternalOffer.interest_id == identity)
                .order_by(ExternalOffer.external_offer_key)
                .limit(1)
            )
            assert offer is not None
            return {"interest_id": identity, "offer_id": offer.id}

    data = run_async(api_client, setup)
    watch = create(api_client, prefix, data)
    watch = api_client.patch(
        f"{prefix}/price-watch/{watch['id']}",
        json={"expected_revision": 1, "target_amount": "70000"},
    ).json()
    enqueue(api_client, prefix, watch)

    async def execute() -> None:
        async with get_session_factory().begin() as session:
            lease = await claim_run(session, now=datetime.now(UTC))
            assert lease is not None
        await execute_run(lease, settings=get_settings(), transport=transport)
        async with get_session_factory()() as session:
            run = await session.get(PriceWatchRun, lease.run_id)
            assert run is not None
            assert run.status == "succeeded" and run.outcome == "notified"
            assert (
                await session.scalar(select(func.count()).select_from(ExternalPriceObservation))
                == 6
            )
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 1

    run_async(api_client, execute)
    assert requests.count("/search") == 2
    llm.assert_not_called()


def test_full_delivery_queue_preserves_app_notification_without_more_pending_pushes(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sooljang.application.price_watch_worker as worker

    monkeypatch.setattr(worker, "MAX_PENDING_DELIVERIES", 0)
    monkeypatch.setattr(get_settings(), "push_vapid_private_key", PRIVATE)
    monkeypatch.setattr(get_settings(), "push_vapid_subject", "mailto:admin@example.com")
    info, _, _ = subscription()
    assert api_client.post(f"{prefix}/price-watch/subscriptions", json=info).status_code == 201
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    watch = api_client.patch(
        f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 1, "push_enabled": True}
    ).json()
    enqueue(api_client, prefix, watch)

    async def exercise() -> None:
        async with get_session_factory().begin() as session:
            lease = await claim_run(session, now=datetime.now(UTC))
            assert lease is not None
        async with get_session_factory().begin() as session:
            await process_results(
                session,
                lease=lease,
                results=[result_for(data)],
                now=datetime.now(UTC),
                settings=get_settings(),
            )
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 1
            row = await session.scalar(select(PushDelivery))
            assert row is not None and row.status == "queue_full"
            assert await claim_delivery(session, now=datetime.now(UTC)) is None

    run_async(api_client, exercise)


@pytest.mark.parametrize("failure", [False, True])
def test_stop_and_result_finalization_use_watch_then_run_locks_without_deadlock(
    api_client: TestClient, prefix: str, failure: bool
) -> None:
    from sqlalchemy import event, text

    from sooljang.application.price_watch import owned_watch, update_watch
    from sooljang.application.price_watch_worker import _finish_failed
    from sooljang.infrastructure.database.session import get_engine

    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    enqueue(api_client, prefix, watch)

    async def exercise() -> None:
        async with get_session_factory().begin() as session:
            lease = await claim_run(session, now=datetime.now(UTC))
            assert lease is not None
        waiting = asyncio.Event()

        def watched_query(
            _connection: Any,
            _cursor: Any,
            statement: str,
            _parameters: Any,
            _context: Any,
            _many: Any,
        ) -> None:
            if "FROM price_watch " in statement and "FOR UPDATE" in statement:
                waiting.set()

        async with get_session_factory().begin() as processing:
            # execute_run처럼 오래된 객체를 같은 identity map에 먼저 둔다.
            stale = await processing.get(PriceWatch, lease.watch_id)
            assert stale is not None
            async with get_session_factory().begin() as stopping:
                await owned_watch(
                    stopping, user_id=lease.user_id, watch_id=lease.watch_id, lock=True
                )
                await stopping.execute(text("SET LOCAL lock_timeout = '1s'"))
                event.listen(get_engine().sync_engine, "before_cursor_execute", watched_query)
                task = asyncio.create_task(
                    _finish_failed(lease, outcome="network_error", now=datetime.now(UTC))
                    if failure
                    else process_results(
                        processing,
                        lease=lease,
                        results=[result_for(data)],
                        now=datetime.now(UTC),
                        settings=get_settings(),
                    )
                )
                try:
                    async with asyncio.timeout(3):
                        await waiting.wait()
                        await update_watch(
                            stopping,
                            user_id=lease.user_id,
                            watch_id=lease.watch_id,
                            expected_revision=1,
                            fields={"is_active": False},
                        )
                        await stopping.commit()
                        await task
                finally:
                    event.remove(get_engine().sync_engine, "before_cursor_execute", watched_query)
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
            assert await processing.scalar(select(func.count()).select_from(PriceNotification)) == 0
        async with get_session_factory()() as session:
            row = await session.get(PriceWatchRun, lease.run_id)
            assert row is not None and row.status == "cancelled"

    run_async(api_client, exercise)


def test_execute_run_reloads_previously_loaded_watch_after_last_http_response(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sooljang.application import discovery
    from sooljang.application.price_watch_worker import execute_run

    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    enqueue(api_client, prefix, watch)

    async def exercise() -> None:
        async with get_session_factory().begin() as session:
            lease = await claim_run(session, now=datetime.now(UTC))
            assert lease is not None
        entered = asyncio.Event()
        respond = asyncio.Event()

        async def held_lookup(session: Any, **_kwargs: Any) -> list[SourceLookupResult]:
            loaded = await session.get(PriceWatch, lease.watch_id)
            assert loaded is not None and loaded.config_revision == 1
            entered.set()
            await respond.wait()
            # SQLAlchemy identity map은 여전히 이전 객체다. 결과 확정에서 다시 읽어야 한다.
            assert loaded.config_revision == 1
            return [result_for(data)]

        monkeypatch.setattr(discovery, "lookup_interest", held_lookup)
        task = asyncio.create_task(execute_run(lease, settings=get_settings()))
        try:
            async with asyncio.timeout(3):
                await entered.wait()
                async with get_session_factory().begin() as session:
                    current = await session.get(PriceWatch, lease.watch_id)
                    assert current is not None
                    current.is_active = False
                    current.config_revision += 1
                respond.set()
                await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        async with get_session_factory()() as session:
            assert await session.scalar(select(func.count()).select_from(PriceNotification)) == 0
            row = await session.get(PriceWatch, lease.watch_id)
            assert row is not None and not row.is_active

    run_async(api_client, exercise)


@pytest.mark.parametrize("changed", ["source", "interest"])
def test_outbound_blocking_uses_latest_source_and_interest_despite_cached_objects(
    api_client: TestClient, prefix: str, changed: str
) -> None:
    from sooljang.application.price_watch import blocking_reason
    from sooljang.infrastructure.database.models import ExternalSource, Interest

    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)

    async def exercise() -> None:
        async with get_session_factory()() as reading:
            target = await reading.get(PriceWatch, uuid.UUID(watch["id"]))
            assert target is not None
            cached_source = await reading.get(ExternalSource, data["source_id"])
            assert cached_source is not None
            cached_interest = await reading.get(Interest, data["interest_id"])
            assert cached_interest is not None
            async with get_session_factory().begin() as updating:
                if changed == "source":
                    source = await updating.get(ExternalSource, data["source_id"])
                    assert source is not None
                    source.is_active = False
                else:
                    interest = await updating.get(Interest, data["interest_id"])
                    assert interest is not None
                    interest.source_matches = {}
            assert cached_source.is_active and cached_interest.source_matches
            assert await blocking_reason(reading, target) == (
                "source_unavailable" if changed == "source" else "product_unpinned"
            )

    run_async(api_client, exercise)
