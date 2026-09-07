"""실제 PostgreSQL/API로 가격 감시 opt-in·소유권·관측 보존·구독 비밀을 검증한다."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from sooljang.application.external_offers import record_offers
from sooljang.application.external_sources import SourceLookupResult
from sooljang.application.price_watch_worker import claim_run, process_results
from sooljang.config import get_settings
from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.database.models import (
    ExternalOffer,
    ExternalSource,
    Interest,
)
from sooljang.infrastructure.database.session import get_session_factory
from tests.infrastructure.test_web_push import PRIVATE, subscription

CONDITIONS = {
    "price_kind": "regular",
    "membership": "none",
    "coupon": "none",
    "fulfillment": "pickup",
    "region": "서울",
    "shipping": "none",
    "tax": "included",
}
FACTS: dict[str, Any] = {
    **CONDITIONS,
    "product_key": "product-one",
    "offer_key": "offer-one",
    "condition_key": "a" * 64,
    "name": "합성 12년 700ml",
    "source_url": "https://example.com/product-one",
    "amount": "49000",
    "currency": "KRW",
    "volume_ml": 700,
    "units": 1,
    "is_set": False,
    "in_stock": True,
    "needs_confirmation": False,
}


def seed(client: TestClient, prefix: str) -> dict[str, Any]:
    user_id = uuid.UUID(client.get(f"{prefix}/auth/me").json()["id"])

    async def insert_data() -> dict[str, Any]:
        async with get_session_factory().begin() as session:
            source = ExternalSource(
                user_id=user_id,
                name="합성 가격 소스",
                base_url="https://example.com",
                adapter_spec={
                    "search": {
                        "url_template": "https://example.com/search?q={query}",
                        "item": "items",
                        "fields": {},
                    }
                },
                price_history_allowed=True,
            )
            session.add(source)
            await session.flush()
            interest = Interest(
                user_id=user_id,
                name="합성 관심",
                identity={"name": "합성 12년 700ml"},
                source_matches={
                    str(source.id): {
                        "product_key": "product-one",
                        "external_url": FACTS["source_url"],
                        "external_key": "offer-one",
                        "external_name": FACTS["name"],
                    }
                },
            )
            session.add(interest)
            await session.flush()
            fetched = datetime.now(UTC)
            offers = await record_offers(
                session,
                user_id=user_id,
                source_id=source.id,
                product_id=None,
                interest_id=interest.id,
                fetched_at=fetched,
                offers=[FACTS],
            )
            offer = await session.scalar(
                select(ExternalOffer).where(ExternalOffer.interest_id == interest.id)
            )
            assert offer is not None
            return {
                "user_id": user_id,
                "source_id": source.id,
                "interest_id": interest.id,
                "offer_id": offer.id,
                "offers": offers,
                "fetched_at": fetched,
            }

    assert client.portal is not None
    return client.portal.call(insert_data)


def create(client: TestClient, prefix: str, data: dict[str, Any]) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/price-watch",
        json={
            "interest_id": str(data["interest_id"]),
            "offer_id": str(data["offer_id"]),
            "target_amount": "50000",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_target_registration_keeps_schedule_and_push_off_and_history_unchanged(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    assert watch["schedule_enabled"] is False and watch["push_enabled"] is False
    assert watch["last_checked_at"] is None and watch["latest_run"] is None
    first = api_client.get(f"{prefix}/price-watch/interests/{data['interest_id']}/history")
    second = api_client.get(f"{prefix}/price-watch/interests/{data['interest_id']}/history")
    assert first.json() == second.json() and len(first.json()) == 1
    assert datetime.fromisoformat(first.json()[0]["fetched_at"]) == data["fetched_at"]
    assert "no-store" in second.headers["cache-control"]


def test_schedule_and_push_opt_in_are_independent_and_changes_use_revision(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    response = api_client.patch(
        f"{prefix}/price-watch/{watch['id']}",
        json={"expected_revision": 1, "schedule_enabled": True, "interval_seconds": 900},
    )
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed["schedule_enabled"] and not changed["push_enabled"]
    assert datetime.fromisoformat(changed["next_due_at"]) > datetime.now(UTC) + timedelta(
        minutes=14
    )
    assert (
        api_client.patch(
            f"{prefix}/price-watch/{watch['id']}",
            json={"expected_revision": 1, "push_enabled": True},
        ).status_code
        == 409
    )
    pushed = api_client.patch(
        f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 2, "push_enabled": True}
    ).json()
    assert pushed["schedule_enabled"] and pushed["push_enabled"]


def test_manual_request_retry_returns_same_run_and_does_not_enable_schedule(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    request_id = str(uuid.uuid4())
    body = {"expected_revision": 1, "request_id": request_id}
    one = api_client.post(f"{prefix}/price-watch/{watch['id']}/check", json=body)
    two = api_client.post(f"{prefix}/price-watch/{watch['id']}/check", json=body)
    assert one.status_code == two.status_code == 202
    assert one.json()["id"] == two.json()["id"]
    assert not api_client.get(f"{prefix}/price-watch").json()[0]["schedule_enabled"]


def test_paused_watch_blocks_requests_and_delete_preserves_interest_and_history(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    paused = api_client.patch(
        f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 1, "is_active": False}
    ).json()
    assert (
        api_client.post(
            f"{prefix}/price-watch/{watch['id']}/check",
            json={"expected_revision": paused["config_revision"], "request_id": str(uuid.uuid4())},
        ).status_code
        == 409
    )
    assert (
        api_client.request(
            "DELETE",
            f"{prefix}/price-watch/{watch['id']}",
            json={"expected_revision": paused["config_revision"]},
        ).status_code
        == 204
    )
    assert api_client.get(f"{prefix}/price-watch").json() == []
    assert (
        len(api_client.get(f"{prefix}/price-watch/interests/{data['interest_id']}/history").json())
        == 1
    )


def test_same_observation_generates_only_one_logical_notification(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    api_client.post(
        f"{prefix}/price-watch/{watch['id']}/check",
        json={"expected_revision": 1, "request_id": str(uuid.uuid4())},
    )

    async def process() -> None:
        async with get_session_factory().begin() as session:
            lease = await claim_run(session, now=datetime.now(UTC))
            assert lease is not None
        result = SourceLookupResult(
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
        )
        async with get_session_factory().begin() as session:
            await process_results(
                session,
                lease=lease,
                results=[result],
                now=datetime.now(UTC),
                settings=get_settings(),
            )
            await process_results(
                session,
                lease=lease,
                results=[result],
                now=datetime.now(UTC),
                settings=get_settings(),
            )

    assert api_client.portal is not None
    api_client.portal.call(process)
    notices = api_client.get(f"{prefix}/price-watch/notifications").json()
    assert len(notices) == 1
    assert notices[0]["amount"] == "49000.0000" and notices[0]["delivery_states"] == []


def test_push_registration_encrypts_endpoint_and_never_returns_keys(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "push_vapid_private_key", PRIVATE)
    monkeypatch.setattr(get_settings(), "push_vapid_subject", "mailto:admin@example.com")
    info, _, _ = subscription()
    response = api_client.post(f"{prefix}/price-watch/subscriptions", json=info)
    assert response.status_code == 201, response.text
    listed = api_client.get(f"{prefix}/price-watch/subscriptions")
    assert info["endpoint"] not in response.text + listed.text
    assert info["keys"]["auth"] not in response.text + listed.text
    assert info["keys"]["p256dh"] not in response.text + listed.text
    assert "no-store" in listed.headers["cache-control"]
    assert (
        api_client.delete(f"{prefix}/price-watch/subscriptions/{response.json()['id']}").status_code
        == 204
    )
    assert api_client.get(f"{prefix}/price-watch/subscriptions").json() == []


def test_watch_endpoints_require_authentication(anon_client: TestClient, prefix: str) -> None:
    for suffix in ("", "/config", "/notifications", "/subscriptions"):
        assert anon_client.get(f"{prefix}/price-watch{suffix}").status_code == 401


def test_other_users_cannot_access_watch_history_or_jobs(
    api_client: TestClient, prefix: str
) -> None:
    from sooljang.infrastructure.database.models.price_watch import PriceWatch, PriceWatchRun

    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    queued = api_client.post(
        f"{prefix}/price-watch/{watch['id']}/check",
        json={"expected_revision": 1, "request_id": str(uuid.uuid4())},
    ).json()
    other = uuid.uuid4()

    async def transfer() -> None:
        async with get_session_factory().begin() as session:
            row = await session.get(PriceWatch, uuid.UUID(watch["id"]))
            assert row is not None
            row.user_id = other
            interest = await session.get(Interest, data["interest_id"])
            assert interest is not None
            interest.user_id = other
            job = await session.get(PriceWatchRun, uuid.UUID(queued["id"]))
            assert job is not None
            job.user_id = other

    assert api_client.portal is not None
    api_client.portal.call(transfer)
    assert api_client.get(f"{prefix}/price-watch").json() == []
    assert (
        api_client.get(f"{prefix}/price-watch/interests/{data['interest_id']}/history").status_code
        == 404
    )
    assert api_client.get(f"{prefix}/price-watch/runs/{queued['id']}").status_code == 404
    assert (
        api_client.patch(
            f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 1, "is_active": False}
        ).status_code
        == 404
    )
    assert (
        api_client.request(
            "DELETE", f"{prefix}/price-watch/{watch['id']}", json={"expected_revision": 1}
        ).status_code
        == 404
    )
    assert (
        api_client.post(
            f"{prefix}/price-watch/{watch['id']}/check",
            json={"expected_revision": 1, "request_id": str(uuid.uuid4())},
        ).status_code
        == 404
    )


def test_owned_product_history_keeps_original_observation_and_never_creates_a_watch(
    api_client: TestClient, prefix: str
) -> None:
    from sooljang.infrastructure.database.models import Product

    data = seed(api_client, prefix)
    product = api_client.post(
        f"{prefix}/products", json={"name": "기존 제품", "skus": [{"volume_ml": 700}]}
    ).json()
    product_id = uuid.UUID(product["id"])

    async def record() -> None:
        async with get_session_factory().begin() as session:
            await record_offers(
                session,
                user_id=data["user_id"],
                source_id=data["source_id"],
                product_id=product_id,
                fetched_at=data["fetched_at"],
                offers=[FACTS],
            )

    assert api_client.portal is not None
    api_client.portal.call(record)
    response = api_client.get(f"{prefix}/price-watch/products/{product_id}/history")
    assert response.status_code == 200 and len(response.json()) == 1
    assert datetime.fromisoformat(response.json()[0]["fetched_at"]) == data["fetched_at"]
    assert api_client.get(f"{prefix}/price-watch").json() == []

    async def transfer() -> None:
        async with get_session_factory().begin() as session:
            row = await session.get(Product, product_id)
            assert row is not None
            row.user_id = uuid.uuid4()

    api_client.portal.call(transfer)
    assert api_client.get(f"{prefix}/price-watch/products/{product_id}/history").status_code == 404


def test_disabled_worker_rejects_manual_queue_without_losing_target(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    monkeypatch.setattr(get_settings(), "price_watch_worker_enabled", False)
    assert (
        api_client.post(
            f"{prefix}/price-watch/{watch['id']}/check",
            json={"expected_revision": 1, "request_id": str(uuid.uuid4())},
        ).status_code
        == 409
    )
    assert api_client.get(f"{prefix}/price-watch").json()[0]["latest_run"] is None
