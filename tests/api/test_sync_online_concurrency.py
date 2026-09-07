"""온라인 API와 outbox가 같은 행을 수정하는 순서를 실제 DB 잠금으로 검증한다."""

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes import products as product_routes
from sooljang.api.routes import tastings as tasting_routes
from sooljang.application import sync as sync_service
from sooljang.infrastructure.database.models import Product


def _setup(client: TestClient, prefix: str) -> dict[str, Any]:
    product = client.post(
        f"{prefix}/products", json={"name": "원래 합성 제품", "skus": [{"volume_ml": 100}]}
    ).json()
    purchase = client.post(
        f"{prefix}/purchases", json={"sku_id": product["skus"][0]["id"], "quantity": 1}
    ).json()
    bottle = client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()[0]
    assert client.post(f"{prefix}/bottles/{bottle['id']}:open", json={}).status_code == 200
    owner = client.get(f"{prefix}/auth/me").json()["id"]
    sync_headers = {
        "Cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.headers["X-CSRF-Token"],
    }
    # Different device/session: shared cookies would accidentally serialize on last_seen_at.
    login = client.post(
        f"{prefix}/auth/login",
        json={"email": "owner@example.com", "password": "sooljang-test-1234"},
    )
    assert login.status_code == 200
    client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    return {"product": product, "bottle": bottle, "owner": owner, "sync_headers": sync_headers}


def _post_sync(
    client: TestClient,
    prefix: str,
    owner: str,
    entity: str,
    entity_id: str,
    op: str,
    fields: dict[str, Any],
    action: str | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/sync/batch",
        headers=headers,
        json={
            "expected_user_id": owner,
            "operations": [
                {
                    "idempotency_key": str(uuid.uuid4()),
                    "entity": entity,
                    "entity_id": entity_id,
                    "op": op,
                    "fields": fields,
                    "action": action,
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(
    ("sync_amount", "online_amount", "remaining", "online_status"),
    [(30, 40, 30, 201), (80, 40, 20, 409)],
)
def test_online_tasting_rechecks_amount_after_sync_row_lock(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    sync_amount: int,
    online_amount: int,
    remaining: int,
    online_status: int,
) -> None:
    data = _setup(api_client, prefix)
    sync_locked, release_sync, online_started, online_read = (threading.Event() for _ in range(4))
    original_sync = sync_service._load_bottle
    original_online = tasting_routes._get_bottle

    async def hold_sync(*args: Any, **kwargs: Any) -> Any:
        bottle = await original_sync(*args, **kwargs)
        sync_locked.set()
        assert await asyncio.to_thread(release_sync.wait, 5)
        return bottle

    async def observe_online(*args: Any, **kwargs: Any) -> Any:
        online_started.set()
        bottle = await original_online(*args, **kwargs)
        online_read.set()
        return bottle

    monkeypatch.setattr(sync_service, "_load_bottle", hold_sync)
    monkeypatch.setattr(tasting_routes, "_get_bottle", observe_online)
    with ThreadPoolExecutor(max_workers=2) as executor:
        sync_future = executor.submit(
            _post_sync,
            api_client,
            prefix,
            data["owner"],
            "tasting_session",
            str(uuid.uuid4()),
            "action",
            {
                "bottle_id": data["bottle"]["id"],
                "tasted_on": "2026-09-07",
                "poured_ml": sync_amount,
            },
            "record_tasting",
            headers=data["sync_headers"],
        )
        assert sync_locked.wait(3)
        online_future = executor.submit(
            api_client.post,
            f"{prefix}/tastings",
            json={
                "bottle_id": data["bottle"]["id"],
                "tasted_on": "2026-09-07",
                "poured_ml": online_amount,
            },
        )
        try:
            assert online_started.wait(3)
            # Without a write lock this read completes against the old remaining amount.
            online_read.wait(0.3)
        finally:
            release_sync.set()
        assert sync_future.result(timeout=5)["results"][0]["status"] == "applied"
        assert online_future.result(timeout=5).status_code == online_status
    bottle = api_client.get(f"{prefix}/bottles/{data['bottle']['id']}").json()
    assert bottle["remaining_ml"] == remaining
    tastings = api_client.get(f"{prefix}/bottles/{data['bottle']['id']}/tastings").json()
    assert sum(tasting["poured_ml"] for tasting in tastings) == 100 - remaining


def test_online_product_patch_uses_current_row_after_sync_lock(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = _setup(api_client, prefix)
    product_id = data["product"]["id"]
    sync_locked, release_sync, online_started, online_read = (threading.Event() for _ in range(4))
    original_sync = sync_service._load_writable
    original_online = product_routes.load_product

    async def hold_sync(session: Any, model: Any, **kwargs: Any) -> Any:
        row = await original_sync(session, model, **kwargs)
        if model is Product:
            sync_locked.set()
            assert await asyncio.to_thread(release_sync.wait, 5)
        return row

    async def observe_online(*args: Any, **kwargs: Any) -> Any:
        online_started.set()
        product = await original_online(*args, **kwargs)
        online_read.set()
        return product

    monkeypatch.setattr(sync_service, "_load_writable", hold_sync)
    monkeypatch.setattr(product_routes, "load_product", observe_online)
    with ThreadPoolExecutor(max_workers=2) as executor:
        sync_future = executor.submit(
            _post_sync,
            api_client,
            prefix,
            data["owner"],
            "product",
            product_id,
            "update",
            {"name": "동기화에서 바꾼 이름"},
            headers=data["sync_headers"],
        )
        assert sync_locked.wait(3)
        online_future = executor.submit(
            api_client.patch,
            f"{prefix}/products/{product_id}",
            json={"name": "원래 합성 제품", "note": "온라인에서 명시적으로 저장"},
        )
        try:
            assert online_started.wait(3)
            online_read.wait(0.3)
        finally:
            release_sync.set()
        assert sync_future.result(timeout=5)["results"][0]["status"] == "applied"
        assert online_future.result(timeout=5).status_code == 200
    current = api_client.get(f"{prefix}/products/{product_id}").json()
    assert current["name"] == "원래 합성 제품"
    assert current["note"] == "온라인에서 명시적으로 저장"


def test_online_finish_cannot_overwrite_bottle_given_away_by_sync(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = _setup(api_client, prefix)
    sync_locked, release_sync, online_started, online_read = (threading.Event() for _ in range(4))
    original_sync = sync_service._load_bottle
    original_online = tasting_routes._get_bottle

    async def hold_sync(*args: Any, **kwargs: Any) -> Any:
        bottle = await original_sync(*args, **kwargs)
        sync_locked.set()
        assert await asyncio.to_thread(release_sync.wait, 5)
        return bottle

    async def observe_online(*args: Any, **kwargs: Any) -> Any:
        online_started.set()
        bottle = await original_online(*args, **kwargs)
        online_read.set()
        return bottle

    monkeypatch.setattr(sync_service, "_load_bottle", hold_sync)
    monkeypatch.setattr(tasting_routes, "_get_bottle", observe_online)
    with ThreadPoolExecutor(max_workers=2) as executor:
        sync_future = executor.submit(
            _post_sync,
            api_client,
            prefix,
            data["owner"],
            "bottle",
            data["bottle"]["id"],
            "action",
            {},
            "gift",
            headers=data["sync_headers"],
        )
        assert sync_locked.wait(3)
        online_future = executor.submit(
            api_client.post, f"{prefix}/bottles/{data['bottle']['id']}:finish", json={}
        )
        try:
            assert online_started.wait(3)
            online_read.wait(0.3)
        finally:
            release_sync.set()
        assert sync_future.result(timeout=5)["results"][0]["status"] == "applied"
        assert online_future.result(timeout=5).status_code == 409
    current = api_client.get(f"{prefix}/bottles/{data['bottle']['id']}").json()
    assert current["status"] == "gifted"
    assert current["remaining_ml"] == 100
