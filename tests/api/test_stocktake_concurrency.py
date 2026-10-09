"""실사 정정·스캔·위치 반영·위치 삭제가 같은 잠금 순서로 완료되는지 확인한다."""

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from sooljang.application import collection_cleanup, collection_inventory
from sooljang.infrastructure.database.models import BottlePlacement, Stocktake, StorageLocation
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_collection_management import post
from tests.api.test_stocktake_corrections import correction_path, setup_observation


def second_device(client: TestClient, prefix: str) -> dict[str, str]:
    previous = {
        "Cookie": "; ".join(f"{key}={value}" for key, value in client.cookies.items()),
        "X-CSRF-Token": client.headers["X-CSRF-Token"],
    }
    login = client.post(
        f"{prefix}/auth/login",
        json={"email": "owner@example.com", "password": "sooljang-test-1234"},
    )
    assert login.status_code == 200, login.text
    client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    return previous


def test_two_devices_cannot_overwrite_the_same_observation_from_a_stale_value(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = setup_observation(api_client, prefix)
    first_headers = second_device(api_client, prefix)
    locked, release, second_started, second_read = (threading.Event() for _ in range(4))
    original_owned = collection_inventory.owned

    async def hold_first_stocktake(*args: Any, **kwargs: Any) -> Any:
        is_stocktake = args[1] is Stocktake
        second = is_stocktake and locked.is_set()
        if second:
            second_started.set()
        row = await original_owned(*args, **kwargs)
        if second:
            second_read.set()
        elif is_stocktake:
            locked.set()
            assert await asyncio.to_thread(release.wait, 5)
        return row

    monkeypatch.setattr(collection_inventory, "owned", hold_first_stocktake)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            api_client.patch,
            correction_path(prefix, data),
            headers=first_headers,
            json={
                "observed_location_id": data["locations"][0],
                "expected_observed_location_id": data["locations"][1],
            },
        )
        try:
            assert locked.wait(3)
            second = executor.submit(
                api_client.patch,
                correction_path(prefix, data),
                json={
                    "observed_location_id": data["locations"][2],
                    "expected_observed_location_id": data["locations"][1],
                },
            )
            assert second_started.wait(3)
            assert not second_read.wait(0.3)
        finally:
            release.set()
        first_result, second_result = first.result(timeout=5), second.result(timeout=5)
    assert first_result.status_code == 200, first_result.text
    assert second_result.status_code == 409, second_result.text
    current = api_client.get(f"{prefix}/collection/stocktakes").json()[0]
    assert current["observations"][0]["observed_location_id"] == data["locations"][0]


def test_apply_waits_for_scan_location_before_locking_stocktake(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = setup_observation(api_client, prefix)
    second_bottle = next(
        row
        for row in api_client.get(f"{prefix}/collection/bottles").json()
        if row["id"] != data["bottle"]["id"]
    )
    first_headers = second_device(api_client, prefix)
    location_locked, release, apply_started, apply_stock_locked = (
        threading.Event() for _ in range(4)
    )
    original_owned = collection_inventory.owned
    original_apply = collection_inventory.apply_observed_locations
    scan_session = None

    async def hold_scan_location(*args: Any, **kwargs: Any) -> Any:
        nonlocal scan_session
        row = await original_owned(*args, **kwargs)
        if args[1] is StorageLocation and not location_locked.is_set():
            scan_session = args[0]
            location_locked.set()
            assert await asyncio.to_thread(release.wait, 5)
        elif args[1] is Stocktake and args[0] is not scan_session:
            apply_stock_locked.set()
        return row

    async def observe_apply(*args: Any, **kwargs: Any) -> Any:
        apply_started.set()
        return await original_apply(*args, **kwargs)

    from sooljang.api.routes import collection_management

    monkeypatch.setattr(collection_inventory, "owned", hold_scan_location)
    monkeypatch.setattr(collection_management, "apply_observed_locations", observe_apply)
    stocktake_path = f"{prefix}/collection/stocktakes/{data['stocktake']['id']}"
    with ThreadPoolExecutor(max_workers=2) as executor:
        scan = executor.submit(
            api_client.post,
            f"{stocktake_path}/scan",
            headers=first_headers,
            json={
                "bottle_code": second_bottle["bottle_code"],
                "observed_location_id": data["locations"][1],
            },
        )
        try:
            assert location_locked.wait(3)
            apply = executor.submit(api_client.post, f"{stocktake_path}:apply-locations")
            assert apply_started.wait(3)
            assert not apply_stock_locked.wait(0.3)
        finally:
            release.set()
        scan_result, apply_result = scan.result(timeout=5), apply.result(timeout=5)
    assert scan_result.status_code == 200, scan_result.text
    assert apply_result.status_code == 200, apply_result.text
    assert apply_result.json()["moved"] == 2
    assert apply_result.json()["stocktake"]["mismatch_count"] == 0


def test_location_delete_waits_for_apply_source_location_without_deadlock(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = setup_observation(api_client, prefix, scoped=True)
    preview = post(
        api_client,
        prefix,
        "/collection/cleanup/preview",
        {"kind": "location_delete", "ids": [data["locations"][0]]},
    )
    first_headers = second_device(api_client, prefix)
    stock_locked, release, delete_started, delete_location_locked = (
        threading.Event() for _ in range(4)
    )
    original_owned = collection_inventory.owned
    original_owned_many = collection_cleanup.owned_many

    async def hold_apply_stocktake(*args: Any, **kwargs: Any) -> Any:
        row = await original_owned(*args, **kwargs)
        if args[1] is Stocktake and not stock_locked.is_set():
            stock_locked.set()
            assert await asyncio.to_thread(release.wait, 5)
        return row

    async def observe_delete_location(*args: Any, **kwargs: Any) -> Any:
        if args[1] is StorageLocation:
            delete_started.set()
        rows = await original_owned_many(*args, **kwargs)
        if args[1] is StorageLocation:
            delete_location_locked.set()
        return rows

    monkeypatch.setattr(collection_inventory, "owned", hold_apply_stocktake)
    monkeypatch.setattr(collection_cleanup, "owned_many", observe_delete_location)
    with ThreadPoolExecutor(max_workers=2) as executor:
        apply = executor.submit(
            api_client.post,
            f"{prefix}/collection/stocktakes/{data['stocktake']['id']}:apply-locations",
            headers=first_headers,
        )
        try:
            assert stock_locked.wait(3)
            delete = executor.submit(
                api_client.post, f"{prefix}/collection/cleanup/{preview['id']}/confirm"
            )
            assert delete_started.wait(3)
            assert not delete_location_locked.wait(0.3)
        finally:
            release.set()
        apply_result, delete_result = apply.result(timeout=5), delete.result(timeout=5)
    assert apply_result.status_code == 200, apply_result.text
    # 위치가 바뀌어 삭제 미리보기가 낡았으므로 재확인을 요구한다.
    assert delete_result.status_code == 409, delete_result.text
    bottle = next(
        row
        for row in api_client.get(f"{prefix}/collection/bottles").json()
        if row["id"] == data["bottle"]["id"]
    )
    assert bottle["location_id"] == data["locations"][1]


def test_apply_retries_if_correction_changes_target_locations_before_stocktake_lock(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = setup_observation(api_client, prefix)
    original_owned = collection_inventory.owned
    changed = False

    async def correct_between_locks(*args: Any, **kwargs: Any) -> Any:
        nonlocal changed
        if args[1] is Stocktake and not changed:
            changed = True
            async with get_session_factory().begin() as edit:
                await edit.execute(
                    update(Stocktake)
                    .where(Stocktake.id == uuid.UUID(data["stocktake"]["id"]))
                    .values(
                        observations={
                            data["bottle"]["id"]: {
                                "bottle_id": data["bottle"]["id"],
                                "recorded_location_id": data["locations"][0],
                                "observed_location_id": data["locations"][2],
                                "result": "location_mismatch",
                            }
                        }
                    )
                )
        return await original_owned(*args, **kwargs)

    monkeypatch.setattr(collection_inventory, "owned", correct_between_locks)
    path = f"{prefix}/collection/stocktakes/{data['stocktake']['id']}:apply-locations"
    response = api_client.post(path)
    assert response.status_code == 409, response.text
    retry = api_client.post(path)
    assert retry.status_code == 200, retry.text
    assert retry.json()["moved"] == 1
    bottle = next(
        row
        for row in api_client.get(f"{prefix}/collection/bottles").json()
        if row["id"] == data["bottle"]["id"]
    )
    assert bottle["location_id"] == data["locations"][2]


def test_scan_location_lock_allows_in_flight_move_to_preserve_source_history(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = setup_observation(api_client, prefix)
    stocktake = post(api_client, prefix, "/collection/stocktakes", {"name": "이동과 동시에 실사"})
    first_headers = second_device(api_client, prefix)
    bottle_locked, release, scan_stock_locked = (threading.Event() for _ in range(3))
    original_bottle = collection_inventory.load_bottle_for_write
    original_owned = collection_inventory.owned

    async def hold_move_bottle(*args: Any, **kwargs: Any) -> Any:
        bottle = await original_bottle(*args, **kwargs)
        if not bottle_locked.is_set():
            bottle_locked.set()
            assert await asyncio.to_thread(release.wait, 5)
        return bottle

    async def observe_scan_stocktake(*args: Any, **kwargs: Any) -> Any:
        row = await original_owned(*args, **kwargs)
        if args[1] is Stocktake:
            scan_stock_locked.set()
        return row

    monkeypatch.setattr(collection_inventory, "load_bottle_for_write", hold_move_bottle)
    monkeypatch.setattr(collection_inventory, "owned", observe_scan_stocktake)
    with ThreadPoolExecutor(max_workers=2) as executor:
        move = executor.submit(
            api_client.put,
            f"{prefix}/collection/bottles/{data['bottle']['id']}/location",
            headers=first_headers,
            json={"location_id": data["locations"][2]},
        )
        try:
            assert bottle_locked.wait(3)
            scan = executor.submit(
                api_client.post,
                f"{prefix}/collection/stocktakes/{stocktake['id']}/scan",
                json={
                    "bottle_code": data["bottle"]["bottle_code"],
                    "observed_location_id": data["locations"][0],
                },
            )
            assert scan_stock_locked.wait(3)
        finally:
            release.set()
        move_result, scan_result = move.result(timeout=5), scan.result(timeout=5)
    assert move_result.status_code == 200, move_result.text
    assert scan_result.status_code == 200, scan_result.text
    assert scan_result.json()["observation"]["recorded_location_id"] == data["locations"][2]
    movements = api_client.get(
        f"{prefix}/collection/bottles/{data['bottle']['id']}/movements"
    ).json()
    assert movements[0]["from_location_id"] == data["locations"][0]
    assert movements[0]["to_location_id"] == data["locations"][2]


def test_apply_retries_if_bottle_moves_to_a_new_source_before_bottle_lock(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = setup_observation(api_client, prefix)
    original_owned = collection_inventory.owned
    changed = False

    async def move_after_stocktake_lock(*args: Any, **kwargs: Any) -> Any:
        nonlocal changed
        row = await original_owned(*args, **kwargs)
        if args[1] is Stocktake and not changed:
            changed = True
            async with get_session_factory().begin() as edit:
                await edit.execute(
                    update(BottlePlacement)
                    .where(BottlePlacement.bottle_id == uuid.UUID(data["bottle"]["id"]))
                    .values(location_id=uuid.UUID(data["locations"][2]))
                )
        return row

    monkeypatch.setattr(collection_inventory, "owned", move_after_stocktake_lock)
    path = f"{prefix}/collection/stocktakes/{data['stocktake']['id']}:apply-locations"
    response = api_client.post(path)
    assert response.status_code == 409, response.text
    retry = api_client.post(path)
    assert retry.status_code == 200, retry.text
    assert retry.json()["moved"] == 1
