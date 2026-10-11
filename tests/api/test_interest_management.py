"""관심 편집·복구는 동일 ID와 구매 사실을 보존하고 이전 감시를 중지한다."""

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from sooljang.infrastructure.database.models import ExternalPriceObservation
from sooljang.infrastructure.database.models.price_watch import (
    PriceNotification,
    PushDelivery,
    PushSubscription,
)
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_price_watch import create, seed


def test_interest_delete_restore_requires_current_revision_and_preserves_purchase(
    api_client: TestClient, prefix: str
) -> None:
    row = api_client.post(
        f"{prefix}/interests",
        json={
            "identity": {"name": "복원할 관심", "name_en": "Restore", "volumes_ml": [700]},
            "reference_urls": ["https://example.com/product?sku=700"],
            "note": "보존할 메모",
        },
    ).json()
    path = f"{prefix}/interests/{row['id']}"
    purchase = api_client.post(
        f"{path}/purchase",
        json={
            "expected_updated_at": row["updated_at"],
            "confirmed_identity": True,
            "new_product": {"name": row["name"], "volume_ml": 700},
            "quantity": 1,
        },
    )
    assert purchase.status_code == 201, purchase.text
    row = api_client.get(f"{prefix}/interests").json()[0]
    before = api_client.get(f"{prefix}/stats/summary").json()
    assert (
        api_client.request(
            "DELETE", path, json={"expected_updated_at": "2000-01-01T00:00:00Z"}
        ).status_code
        == 409
    )
    deleted = api_client.request("DELETE", path, json={"expected_updated_at": row["updated_at"]})
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted"] is True
    assert api_client.get(f"{prefix}/interests").json() == []
    assert api_client.get(f"{prefix}/interests?include_deleted=true").json()[0]["id"] == row["id"]
    assert (
        api_client.post(
            f"{path}/restore", json={"expected_updated_at": row["updated_at"]}
        ).status_code
        == 409
    )
    restored = api_client.post(
        f"{path}/restore", json={"expected_updated_at": deleted.json()["updated_at"]}
    )
    assert restored.status_code == 200, restored.text
    result = restored.json()
    assert result["id"] == row["id"] and result["archived"] and not result["deleted"]
    assert result["product_id"] == purchase.json()["product_id"]
    assert result["reference_urls"] == row["reference_urls"]
    assert result["note"] == "보존할 메모"
    assert api_client.get(f"{prefix}/stats/summary").json() == before


def test_identity_edit_unpins_and_cancels_previous_watch_work_without_deleting_history(
    api_client: TestClient, prefix: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    run = api_client.post(
        f"{prefix}/price-watch/{watch['id']}/check",
        json={
            "expected_revision": watch["config_revision"],
            "request_id": "10000000-0000-4000-8000-000000000001",
        },
    )
    assert run.status_code == 202, run.text
    row = api_client.get(f"{prefix}/interests").json()[0]
    changed = api_client.patch(
        f"{prefix}/interests/{row['id']}",
        json={
            "identity": {
                **row["identity"],
                "name": "다른 판본 15년",
                "search_aliases": ["Other 15"],
            },
            "expected_updated_at": row["updated_at"],
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["source_matches"] == {}
    assert changed.json()["identity"]["search_aliases"] == ["Other 15"]
    paused = api_client.get(f"{prefix}/price-watch").json()[0]
    assert not paused["is_active"] and not paused["schedule_enabled"] and not paused["push_enabled"]
    assert (
        api_client.get(f"{prefix}/price-watch/runs/{run.json()['id']}").json()["status"]
        == "cancelled"
    )
    history = api_client.get(f"{prefix}/price-watch/interests/{row['id']}/history").json()
    assert len(history) == 1


def test_interest_reference_rejects_secret_private_and_non_http_urls(
    api_client: TestClient, prefix: str
) -> None:
    for url in ("javascript:alert(1)", "http://127.0.0.1/a", "https://example.com?api_key=secret"):
        response = api_client.post(
            f"{prefix}/interests", json={"identity": {"name": "출처"}, "reference_urls": [url]}
        )
        assert response.status_code == 422, response.text


@pytest.mark.parametrize("change", ["delete", "identity", "unpin"])
def test_interest_change_cancels_queued_push_but_keeps_notification_and_observation(
    api_client: TestClient, prefix: str, change: str
) -> None:
    data = seed(api_client, prefix)
    watch = create(api_client, prefix, data)
    delivery_id, notification_id = uuid.uuid4(), uuid.uuid4()

    async def enqueue_push() -> None:
        async with get_session_factory().begin() as session:
            subscription = PushSubscription(
                user_id=data["user_id"],
                endpoint_hash="a" * 64,
                vapid_key_id="synthetic",
                is_active=False,
            )
            notification = PriceNotification(
                id=notification_id,
                user_id=data["user_id"],
                watch_id=uuid.UUID(watch["id"]),
                interest_id=data["interest_id"],
                watch_revision=watch["config_revision"],
            )
            session.add_all([subscription, notification])
            await session.flush()
            session.add(
                PushDelivery(
                    id=delivery_id,
                    user_id=data["user_id"],
                    notification_id=notification_id,
                    subscription_id=subscription.id,
                    available_at=datetime.now(UTC),
                )
            )

    assert api_client.portal is not None
    api_client.portal.call(enqueue_push)
    row = api_client.get(f"{prefix}/interests").json()[0]
    payload: dict[str, object] = {"expected_updated_at": row["updated_at"]}
    if change == "identity":
        payload["identity"] = {**row["identity"], "name": "새 판본"}
    elif change == "unpin":
        payload["source_matches"] = {}
    result = api_client.request(
        "DELETE" if change == "delete" else "PATCH", f"{prefix}/interests/{row['id']}", json=payload
    )
    assert result.status_code == 200, result.text

    async def inspect() -> None:
        async with get_session_factory()() as session:
            delivery = await session.get(PushDelivery, delivery_id)
            assert delivery is not None and delivery.status == "cancelled"
            assert await session.get(PriceNotification, notification_id) is not None
            assert (
                await session.scalar(select(func.count()).select_from(ExternalPriceObservation))
                == 1
            )

    api_client.portal.call(inspect)
