"""구매 병수 재증가와 서로 다른 기기의 동시 수정을 검증한다."""

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.api.routes import purchases
from sooljang.api.schemas.tasting import TastingOut
from sooljang.infrastructure.database.models import Bottle, Purchase
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_purchases import _post, _product_with_sku


def test_purchase_can_grow_after_shrinking_without_reusing_deleted_bottles_or_changing_tastings(
    api_client: TestClient, prefix: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 3})
    path = f"{prefix}/purchases/{purchase['id']}"
    original = api_client.get(f"{path}/bottles").json()
    tasting = _post(
        api_client,
        f"{prefix}/tastings",
        {
            "bottle_id": original[0]["id"],
            "tasted_on": "2026-10-01",
            "poured_ml": 30,
            "rating": "4.5",
            "note": "수량을 수정해도 보존할 합성 시음",
        },
    )
    tasted_bottle = api_client.get(f"{prefix}/bottles/{original[0]['id']}").json()

    for quantity, labels in ((2, [1, 2]), (3, [1, 2, 4]), (4, [1, 2, 4, 5])):
        response = api_client.patch(path, json={"quantity": quantity})
        assert response.status_code == 200, response.text
        assert response.json()["quantity"] == response.json()["bottle_count"] == quantity
        current = api_client.get(f"{path}/bottles").json()
        assert [bottle["label_no"] for bottle in current] == labels
        assert [bottle["id"] for bottle in current[:2]] == [bottle["id"] for bottle in original[:2]]
        assert original[2]["id"] not in {bottle["id"] for bottle in current}
        assert api_client.get(f"{prefix}/bottles/{original[0]['id']}").json() == tasted_bottle
        timeline = api_client.get(f"{prefix}/bottles/{original[0]['id']}/tastings").json()
        assert len(timeline) == 1
        assert {key: timeline[0][key] for key in TastingOut.model_fields} == {
            key: tasting[key] for key in TastingOut.model_fields
        }
        assert timeline[0]["updated_at"] == tasting["updated_at"]
        assert timeline[0]["purchase"]["id"] == purchase["id"]
        assert timeline[0]["purchase"]["quantity"] == quantity

    async def original_deleted_bottle_is_preserved() -> None:
        async with get_session_factory()() as session:
            deleted = await session.get(Bottle, uuid.UUID(original[2]["id"]))
            assert deleted is not None
            assert deleted.deleted_at is not None
            assert deleted.label_no == 3
            assert str(deleted.purchase_id) == purchase["id"]

    assert api_client.portal is not None
    api_client.portal.call(original_deleted_bottle_is_preserved)


def test_concurrent_quantity_updates_recheck_current_purchase_before_adding_bottles(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 3})
    path = f"{prefix}/purchases/{purchase['id']}"
    original_ids = {bottle["id"] for bottle in api_client.get(f"{path}/bottles").json()}
    first_headers = {
        "Cookie": "; ".join(f"{key}={value}" for key, value in api_client.cookies.items()),
        "X-CSRF-Token": api_client.headers["X-CSRF-Token"],
    }
    # 같은 인증 세션이면 last_seen_at 갱신 잠금이 구매 잠금 누락을 가린다.
    login = api_client.post(
        f"{prefix}/auth/login",
        json={"email": "owner@example.com", "password": "sooljang-test-1234"},
    )
    assert login.status_code == 200, login.text
    api_client.headers["X-CSRF-Token"] = login.json()["csrf_token"]

    first_locked, release_first, second_started, second_read = (threading.Event() for _ in range(4))
    original_resize = purchases._resize_bottles
    original_owned = purchases.owned
    original_gate = purchases.lock_user_writes

    async def hold_first_resize(*args: Any, **kwargs: Any) -> None:
        if args[3] == 4:
            first_locked.set()
            assert await asyncio.to_thread(release_first.wait, 5)
        await original_resize(*args, **kwargs)

    async def observe_purchase_read(*args: Any, **kwargs: Any) -> Any:
        second = args[1] is Purchase and first_locked.is_set()
        row = await original_owned(*args, **kwargs)
        if second:
            second_read.set()
        return row

    async def observe_write_gate(*args: Any, **kwargs: Any) -> None:
        if first_locked.is_set():
            second_started.set()
        await original_gate(*args, **kwargs)

    monkeypatch.setattr(purchases, "_resize_bottles", hold_first_resize)
    monkeypatch.setattr(purchases, "owned", observe_purchase_read)
    monkeypatch.setattr(purchases, "lock_user_writes", observe_write_gate)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(api_client.patch, path, json={"quantity": 4}, headers=first_headers)
        try:
            assert first_locked.wait(3)
            second = executor.submit(api_client.patch, path, json={"quantity": 5})
            assert second_started.wait(3)
            assert not second_read.wait(0.3)
        finally:
            release_first.set()
        first_result, second_result = first.result(timeout=5), second.result(timeout=5)

    assert first_result.status_code == 200, first_result.text
    assert second_result.status_code == 200, second_result.text
    assert first_result.json()["quantity"] == first_result.json()["bottle_count"] == 4
    assert second_result.json()["quantity"] == second_result.json()["bottle_count"] == 5
    current = api_client.get(f"{path}/bottles").json()
    assert len(current) == 5
    assert len({bottle["id"] for bottle in current}) == 5
    assert [bottle["label_no"] for bottle in current] == [1, 2, 3, 4, 5]
    assert original_ids <= {bottle["id"] for bottle in current}
    assert api_client.get(f"{prefix}/purchases").json()[0]["quantity"] == 5
    history = api_client.get(f"{path}/history").json()
    assert [event["detail"]["quantity"] for event in history] == [[4, 5], [3, 4]]
