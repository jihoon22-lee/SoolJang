"""병합과 온라인/동기화 구매 수정은 Vendor→Purchase 순서로 직렬화된다."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes import purchases as purchase_routes
from sooljang.application import collection_cleanup as cleanup
from sooljang.application import sync as sync_service
from sooljang.infrastructure.database.models import Vendor
from tests.api.test_sync_online_concurrency import _post_sync, _setup


@pytest.mark.parametrize("via_sync", [False, True])
def test_vendor_merge_and_purchase_update_finish_without_deadlock(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    via_sync: bool,
) -> None:
    data = _setup(api_client, prefix)
    source = api_client.post(f"{prefix}/vendors", json={"name": "원본 구매처"}).json()
    target = api_client.post(f"{prefix}/vendors", json={"name": "대상 구매처"}).json()
    purchase = api_client.post(
        f"{prefix}/purchases",
        json={"sku_id": data["product"]["skus"][0]["id"], "vendor_id": source["id"], "quantity": 1},
    ).json()
    preview = api_client.post(
        f"{prefix}/collection/cleanup/preview",
        json={"kind": "vendor_merge", "ids": [source["id"]], "target_id": target["id"]},
    ).json()
    locked, release, started = (threading.Event() for _ in range(3))
    original_owned = cleanup.owned
    original_vendor = purchase_routes._owned_vendor
    original_sync = sync_service._load_writable

    async def hold_target(session: Any, model: Any, user_id: Any, entity_id: Any) -> Any:
        row = await original_owned(session, model, user_id, entity_id)
        if model is Vendor and str(entity_id) == target["id"] and not locked.is_set():
            locked.set()
            assert await asyncio.to_thread(release.wait, 5)
        return row

    async def observe_vendor(*args: Any, **kwargs: Any) -> Any:
        started.set()
        return await original_vendor(*args, **kwargs)

    async def observe_sync(session: Any, model: Any, **kwargs: Any) -> Any:
        if model is Vendor:
            started.set()
        return await original_sync(session, model, **kwargs)

    monkeypatch.setattr(cleanup, "owned", hold_target)
    monkeypatch.setattr(purchase_routes, "_owned_vendor", observe_vendor)
    monkeypatch.setattr(sync_service, "_load_writable", observe_sync)
    with ThreadPoolExecutor(max_workers=2) as pool:
        merging = pool.submit(
            api_client.post, f"{prefix}/collection/cleanup/{preview['id']}/confirm"
        )
        try:
            assert locked.wait(5)
            if via_sync:
                updating = pool.submit(
                    _post_sync,
                    api_client,
                    prefix,
                    data["owner"],
                    "purchase",
                    purchase["id"],
                    "update",
                    {"vendor_id": target["id"], "unit_paid_price": "123"},
                    headers=data["sync_headers"],
                )
            else:
                updating = pool.submit(
                    api_client.patch,
                    f"{prefix}/purchases/{purchase['id']}",
                    json={"vendor_id": target["id"], "unit_paid_price": "123"},
                    headers=data["sync_headers"],
                )
            assert started.wait(5)
        finally:
            release.set()
        assert merging.result(timeout=10).status_code == 200
        updated = updating.result(timeout=10)
        if via_sync:
            assert updated["results"][0]["status"] == "applied"
        else:
            assert isinstance(updated, httpx.Response)
            assert updated.status_code == 200
    actual = api_client.get(f"{prefix}/purchases", params={"vendor_id": target["id"]}).json()
    row = next(row for row in actual if row["id"] == purchase["id"])
    assert row["unit_paid_price"] == "123.00"
