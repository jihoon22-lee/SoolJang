"""서로 다른 로그인 세션의 수량 축소와 시음 연결 정정·복구를 직렬화한다."""

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes import purchases
from sooljang.application import corrections, tasting_lifecycle
from tests.api.test_history_corrections import _correct, _tasting
from tests.api.test_review_record_integrity import _tasting_on_unopened_bottle
from tests.api.test_tastings import _create_product_with_bottle


@pytest.mark.parametrize("tasting_action", ["correct", "restore"])
@pytest.mark.parametrize("first_action", ["tasting", "shrink"])
def test_concurrent_shrink_and_tasting_change_never_leave_a_live_tasting_on_a_deleted_bottle(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    tasting_action: str,
    first_action: str,
) -> None:
    if tasting_action == "restore":
        data, tasting = _tasting_on_unopened_bottle(api_client, prefix, quantity=2)
        deleted = api_client.request(
            "DELETE",
            f"{prefix}/tastings/{tasting['id']}",
            json={"request_id": str(uuid.uuid4()), "expected_updated_at": tasting["updated_at"]},
        )
        assert deleted.status_code == 200, deleted.text
        payload = {
            "request_id": str(uuid.uuid4()),
            "expected_updated_at": deleted.json()["updated_at"],
        }
        graph_module = tasting_lifecycle
    else:
        data = _create_product_with_bottle(api_client, prefix, quantity=2)
        tasting = _tasting(api_client, prefix, data["bottles"][0]["id"])
        target = api_client.get(f"{prefix}/bottles/{data['bottles'][1]['id']}").json()
        payload = _correct(tasting, bottle_id=target["id"])
        payload["expected_bottles"].append({"id": target["id"], "revision": target["revision"]})
        graph_module = corrections
    tasting_path = f"{prefix}/tastings/{tasting['id']}:{tasting_action}"
    purchase_path = f"{prefix}/purchases/{data['purchase_id']}"
    first_headers = {
        "Cookie": "; ".join(f"{key}={value}" for key, value in api_client.cookies.items()),
        "X-CSRF-Token": api_client.headers["X-CSRF-Token"],
    }
    login = api_client.post(
        f"{prefix}/auth/login",
        json={"email": "owner@example.com", "password": "sooljang-test-1234"},
    )
    assert login.status_code == 200, login.text
    api_client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    first_held, release_first, second_started, second_passed = (threading.Event() for _ in range(4))
    original_resize = purchases._resize_bottles
    original_graph = graph_module._lock_graph
    original_gate = purchases.lock_user_writes

    async def hold_first() -> None:
        first_held.set()
        assert await asyncio.to_thread(release_first.wait, 10)

    async def resize(*args: Any, **kwargs: Any) -> None:
        if first_action == "shrink":
            await hold_first()
        await original_resize(*args, **kwargs)

    async def graph(*args: Any, **kwargs: Any) -> Any:
        if first_action == "tasting":
            await hold_first()
        return await original_graph(*args, **kwargs)

    async def gate(*args: Any, **kwargs: Any) -> None:
        second = first_held.is_set()
        if second:
            second_started.set()
        await original_gate(*args, **kwargs)
        if second:
            second_passed.set()

    monkeypatch.setattr(purchases, "_resize_bottles", resize)
    monkeypatch.setattr(graph_module, "_lock_graph", graph)
    monkeypatch.setattr(purchases, "lock_user_writes", gate)
    monkeypatch.setattr(corrections, "lock_user_writes", gate)

    def submit(action: str, *, first: bool) -> Any:
        headers = first_headers if first else {}
        if action == "tasting":
            return api_client.post(tasting_path, json=payload, headers=headers)
        return api_client.patch(purchase_path, json={"quantity": 1}, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as executor:
        leading = executor.submit(submit, first_action, first=True)
        try:
            assert first_held.wait(5)
            trailing = executor.submit(
                submit, "shrink" if first_action == "tasting" else "tasting", first=False
            )
            assert second_started.wait(5)
            assert not second_passed.wait(0.2)
        finally:
            release_first.set()
        first_result, second_result = leading.result(timeout=10), trailing.result(timeout=10)

    assert first_result.status_code == 200, first_result.text
    assert second_result.status_code in {404, 409}, second_result.text
    bottles = api_client.get(f"{purchase_path}/bottles").json()
    live_ids = {bottle["id"] for bottle in bottles}
    records = api_client.get(
        f"{prefix}/tastings", params={"product_id": data["product"]["id"]}
    ).json()
    assert all(row["bottle_id"] in live_ids for row in records)
    if first_action == "tasting":
        assert len(bottles) == 2
        assert (
            api_client.get(f"{prefix}/tastings/{tasting['id']}").json()["bottle_id"]
            == data["bottles"][1]["id"]
        )
    else:
        assert len(bottles) == 1
        assert len(records) == (1 if tasting_action == "correct" else 0)
