"""정정과 후속 소비의 직렬화 및 영수증 재전송 동시성."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes import tastings
from sooljang.application import corrections
from tests.api.test_history_corrections import _correct, _purchase_payload, _tasting
from tests.api.test_sku_usage_concurrency import _first_session_headers
from tests.api.test_tastings import _create_product_with_bottle


@pytest.mark.parametrize("operation", ["tasting", "purchase"])
def test_correction_holds_user_gate_until_new_tasting_can_observe_current_sku(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    bid = data["bottles"][0]["id"]
    row = _tasting(api_client, prefix, bid)
    if operation == "tasting":
        url = f"{prefix}/tastings/{row['id']}:correct"
        payload = _correct(row, note="동시성 정정")
        expected_sku = row["sku_id"]
    else:
        target = api_client.post(
            f"{prefix}/products/{row['context']['product_id']}/skus", json={"volume_ml": 1000}
        ).json()
        context = api_client.get(
            f"{prefix}/purchases/{data['purchase_id']}/correction-context"
        ).json()
        url = f"{prefix}/purchases/{data['purchase_id']}:correct-sku"
        payload = _purchase_payload(context, target["id"], 1000)
        expected_sku = target["id"]
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started, acquired = (threading.Event() for _ in range(4))
    original_graph = corrections._lock_graph
    original_entry = tastings.lock_user_writes

    async def pause_graph(*args: Any, **kwargs: Any) -> Any:
        graph = await original_graph(*args, **kwargs)
        held.set()
        assert await asyncio.to_thread(release.wait, 5)
        return graph

    async def observe_entry(*args: Any, **kwargs: Any) -> None:
        started.set()
        await original_entry(*args, **kwargs)
        acquired.set()

    monkeypatch.setattr(corrections, "_lock_graph", pause_graph)
    monkeypatch.setattr(tastings, "lock_user_writes", observe_entry)
    with ThreadPoolExecutor(max_workers=2) as pool:
        correcting = pool.submit(api_client.post, url, json=payload, headers=first_headers)
        assert held.wait(3)
        consuming = pool.submit(
            api_client.post,
            f"{prefix}/tastings",
            json={"bottle_id": bid, "tasted_on": "2026-01-04", "poured_ml": 10},
        )
        try:
            assert started.wait(3)
            assert not acquired.wait(0.2)
        finally:
            release.set()
        corrected = correcting.result(timeout=5)
        consumed = consuming.result(timeout=5)
        assert corrected.status_code == 200, corrected.text
        assert consumed.status_code == 201, consumed.text
    assert consumed.json()["sku_id"] == expected_sku
    assert consumed.json()["bottle"]["remaining_ml"] == 720


def test_concurrent_same_request_returns_one_correction_and_identical_snapshot(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    payload = _correct(row, note="한 번만 수정")
    url = f"{prefix}/tastings/{row['id']}:correct"
    first_headers = _first_session_headers(api_client, prefix)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(api_client.post, url, json=payload, headers=first_headers)
        second = pool.submit(api_client.post, url, json=payload)
        responses = [first.result(timeout=5), second.result(timeout=5)]
    assert all(r.status_code == 200 for r in responses)
    assert responses[0].json() == responses[1].json()
    assert len(api_client.get(f"{prefix}/tastings/{row['id']}/history").json()) == 1
