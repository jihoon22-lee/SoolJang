"""별도 로그인 세션의 SKU 삭제·변경과 새 구매/시음을 실제 DB 잠금으로 직렬화한다."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes import products, purchases, tastings
from sooljang.application import skus
from tests.api.test_purchases import _product_with_sku


def _first_session_headers(client: TestClient, prefix: str) -> dict[str, str]:
    headers = {
        "Cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.headers["X-CSRF-Token"],
    }
    response = client.post(
        f"{prefix}/auth/login",
        json={"email": "owner@example.com", "password": "sooljang-test-1234"},
    )
    assert response.status_code == 200
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return headers


@pytest.mark.parametrize("reference", ["purchase", "tasting"])
def test_sku_delete_winning_lock_prevents_new_reference(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, reference: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started, acquired = (threading.Event() for _ in range(4))
    original_unused = skus.ensure_sku_unused
    routes = purchases if reference == "purchase" else tastings
    original_entry = routes.lock_user_writes

    async def pause_after_unused(*args: Any, **kwargs: Any) -> None:
        await original_unused(*args, **kwargs)
        held.set()
        assert await asyncio.to_thread(release.wait, 5)

    async def observe_entry(*args: Any, **kwargs: Any) -> None:
        started.set()
        await original_entry(*args, **kwargs)
        acquired.set()

    monkeypatch.setattr(skus, "ensure_sku_unused", pause_after_unused)
    monkeypatch.setattr(routes, "lock_user_writes", observe_entry)
    path = "/purchases" if reference == "purchase" else "/tastings"
    payload = {"sku_id": sku_id, **({"tasted_on": "2026-10-01"} if reference == "tasting" else {})}
    with ThreadPoolExecutor(max_workers=2) as pool:
        deletion = pool.submit(api_client.delete, f"{prefix}/skus/{sku_id}", headers=first_headers)
        assert held.wait(3)
        creation = pool.submit(api_client.post, f"{prefix}{path}", json=payload)
        try:
            assert started.wait(3)
            assert not acquired.wait(0.2)
        finally:
            release.set()
        assert deletion.result(timeout=5).status_code == 204
        assert creation.result(timeout=5).status_code == 404
    assert api_client.get(f"{prefix}{path}").json() == []


@pytest.mark.parametrize("reference", ["purchase", "tasting"])
@pytest.mark.parametrize("mutation", ["delete", "volume"])
def test_new_reference_winning_lock_prevents_sku_reinterpretation(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    reference: str,
    mutation: str,
) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started, acquired = (threading.Event() for _ in range(4))
    routes = purchases if reference == "purchase" else tastings
    original_sku = routes.load_live_sku_for_write
    original_entry = products.lock_user_writes

    async def pause_sku(*args: Any, **kwargs: Any) -> Any:
        sku = await original_sku(*args, **kwargs)
        held.set()
        assert await asyncio.to_thread(release.wait, 5)
        return sku

    async def observe_entry(*args: Any, **kwargs: Any) -> None:
        started.set()
        await original_entry(*args, **kwargs)
        acquired.set()

    monkeypatch.setattr(routes, "load_live_sku_for_write", pause_sku)
    monkeypatch.setattr(products, "lock_user_writes", observe_entry)
    path = "/purchases" if reference == "purchase" else "/tastings"
    payload = {"sku_id": sku_id, **({"tasted_on": "2026-10-01"} if reference == "tasting" else {})}
    with ThreadPoolExecutor(max_workers=2) as pool:
        creation = pool.submit(
            api_client.post, f"{prefix}{path}", json=payload, headers=first_headers
        )
        assert held.wait(3)
        if mutation == "delete":
            changed = pool.submit(api_client.delete, f"{prefix}/skus/{sku_id}")
        else:
            changed = pool.submit(
                api_client.patch, f"{prefix}/skus/{sku_id}", json={"volume_ml": 1000}
            )
        try:
            assert started.wait(3)
            assert not acquired.wait(0.2)
        finally:
            release.set()
        assert creation.result(timeout=5).status_code == 201
        assert changed.result(timeout=5).status_code == 409
    current = api_client.get(f"{prefix}/products/{product['id']}").json()
    assert current["skus"][0]["id"] == sku_id
    assert current["skus"][0]["volume_ml"] == 700
    assert len(api_client.get(f"{prefix}{path}").json()) == 1


def test_concurrent_same_volume_creation_has_one_existing_sku_to_choose(
    api_client: TestClient, prefix: str
) -> None:
    product, _ = _product_with_sku(api_client, prefix)
    first_headers = _first_session_headers(api_client, prefix)
    path = f"{prefix}/products/{product['id']}/skus"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(api_client.post, path, json={"volume_ml": 750}, headers=first_headers)
        second = pool.submit(api_client.post, path, json={"volume_ml": 750})
        responses = [first.result(timeout=5), second.result(timeout=5)]
    assert sorted(response.status_code for response in responses) == [201, 409]
    created = next(response.json() for response in responses if response.status_code == 201)
    current = api_client.get(f"{prefix}/products/{product['id']}").json()
    matching = [sku for sku in current["skus"] if sku["volume_ml"] == 750]
    assert [sku["id"] for sku in matching] == [created["id"]]
