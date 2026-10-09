"""실사 오입력 정정은 관찰만 바꾸고 재고·최초 기록 위치를 보존한다."""

import datetime
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from sooljang.infrastructure.database.models import Bottle, Stocktake, StorageLocation, User
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_collection_management import post, sample


def setup_observation(
    client: TestClient, prefix: str, *, expected: bool = True, scoped: bool = False
) -> dict[str, Any]:
    _, _, bottles = sample(client, prefix)
    locations = [
        post(client, prefix, "/collection/locations", {"name": name})["id"]
        for name in ("원래 선반", "잘못 고른 선반", "새 선반")
    ]
    bottle = bottles[0]
    assert (
        client.put(
            f"{prefix}/collection/bottles/{bottle['id']}/location",
            json={"location_id": locations[0]},
        ).status_code
        == 200
    )
    stocktake = post(
        client,
        prefix,
        "/collection/stocktakes",
        {
            "name": "관찰 정정 실사",
            "location_id": locations[0] if scoped else (None if expected else locations[1]),
        },
    )
    scanned = post(
        client,
        prefix,
        f"/collection/stocktakes/{stocktake['id']}/scan",
        {"bottle_code": bottle["bottle_code"], "observed_location_id": locations[1]},
    )
    assert scanned["observation"]["result"] == "location_mismatch"
    return {"bottle": bottle, "stocktake": stocktake, "locations": locations}


def correction_path(prefix: str, data: dict[str, Any]) -> str:
    return (
        f"{prefix}/collection/stocktakes/{data['stocktake']['id']}"
        f"/observations/{data['bottle']['id']}"
    )


def test_correction_preserves_first_recorded_location_and_current_inventory_and_retries_safely(
    api_client: TestClient, prefix: str
) -> None:
    data = setup_observation(api_client, prefix)
    original, wrong, moved = data["locations"]
    bottle_id = data["bottle"]["id"]
    assert (
        api_client.put(
            f"{prefix}/collection/bottles/{bottle_id}/location", json={"location_id": moved}
        ).status_code
        == 200
    )
    inventory = api_client.get(f"{prefix}/collection/bottles").json()
    movements_path = f"{prefix}/collection/bottles/{bottle_id}/movements"
    movements = api_client.get(movements_path).json()
    bottle = api_client.get(f"{prefix}/bottles/{bottle_id}").json()
    path = correction_path(prefix, data)
    payload = {"observed_location_id": original, "expected_observed_location_id": wrong}

    corrected = api_client.patch(path, json=payload)
    assert corrected.status_code == 200, corrected.text
    body = corrected.json()
    assert body["observations"] == [
        {
            "bottle_id": bottle_id,
            "recorded_location_id": original,
            "observed_location_id": original,
            "result": "checked",
        }
    ]
    assert body["observed_count"] == 1
    assert body["mismatch_count"] == body["unexpected_count"] == 0
    assert len(body["missing"]) == 1
    assert api_client.patch(path, json=payload).json() == body
    stale = api_client.patch(
        path, json={"observed_location_id": moved, "expected_observed_location_id": wrong}
    )
    assert stale.status_code == 409, stale.text
    cleared = api_client.patch(
        path, json={"observed_location_id": None, "expected_observed_location_id": original}
    )
    assert cleared.status_code == 200, cleared.text
    observation = cleared.json()["observations"][0]
    assert observation["recorded_location_id"] == original
    assert observation["observed_location_id"] is None
    assert observation["result"] == "location_mismatch"
    assert api_client.get(f"{prefix}/collection/bottles").json() == inventory
    assert api_client.get(movements_path).json() == movements
    assert api_client.get(f"{prefix}/bottles/{bottle_id}").json() == bottle


def test_correction_recomputes_unexpected_result_from_original_stocktake_scope(
    api_client: TestClient, prefix: str
) -> None:
    data = setup_observation(api_client, prefix, expected=False)
    response = api_client.patch(
        correction_path(prefix, data),
        json={
            "observed_location_id": data["locations"][0],
            "expected_observed_location_id": data["locations"][1],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["observations"][0]["result"] == "unexpected"
    assert response.json()["unexpected_count"] == 1
    assert response.json()["expected_count"] == response.json()["mismatch_count"] == 0


@pytest.mark.parametrize("state", ["paused", "completed", "relocated", "relocation_skipped"])
def test_correction_refuses_paused_completed_or_already_applied_observation(
    api_client: TestClient, prefix: str, state: str
) -> None:
    data = setup_observation(api_client, prefix)
    stocktake_path = f"{prefix}/collection/stocktakes/{data['stocktake']['id']}"
    if state in {"paused", "completed"}:
        assert api_client.patch(stocktake_path, json={"status": state}).status_code == 200
    else:
        if state == "relocation_skipped":
            preview = post(
                api_client,
                prefix,
                "/collection/cleanup/preview",
                {"kind": "location_delete", "ids": [data["locations"][1]]},
            )
            post(api_client, prefix, f"/collection/cleanup/{preview['id']}/confirm", {})
        applied = api_client.post(f"{stocktake_path}:apply-locations")
        assert applied.status_code == 200, applied.text
        assert applied.json()["stocktake"]["observations"][0]["result"] == state
    response = api_client.patch(
        correction_path(prefix, data),
        json={
            "observed_location_id": data["locations"][0],
            "expected_observed_location_id": data["locations"][1],
        },
    )
    assert response.status_code == 409, response.text


def test_correction_requires_both_nullable_location_fields_and_an_existing_observation(
    api_client: TestClient, prefix: str
) -> None:
    data = setup_observation(api_client, prefix)
    path = correction_path(prefix, data)
    for payload in ({}, {"observed_location_id": None}, {"expected_observed_location_id": None}):
        assert api_client.patch(path, json=payload).status_code == 422
    stocktake = post(
        api_client, prefix, "/collection/stocktakes", {"name": "아직 관찰하지 않은 실사"}
    )
    data["stocktake"] = stocktake
    response = api_client.patch(
        correction_path(prefix, data),
        json={"observed_location_id": None, "expected_observed_location_id": None},
    )
    assert response.status_code == 404, response.text


@pytest.mark.parametrize("kind", ["missing", "deleted", "foreign"])
@pytest.mark.parametrize("entity", ["stocktake", "bottle", "location"])
def test_correction_rejects_missing_deleted_or_foreign_references(
    api_client: TestClient, prefix: str, entity: str, kind: str
) -> None:
    data = setup_observation(api_client, prefix)
    model, entity_id = {
        "stocktake": (Stocktake, data["stocktake"]["id"]),
        "bottle": (Bottle, data["bottle"]["id"]),
        "location": (StorageLocation, data["locations"][0]),
    }[entity]

    async def invalidate() -> None:
        async with get_session_factory().begin() as session:
            if kind == "deleted":
                await session.execute(
                    update(model)
                    .where(model.id == uuid.UUID(entity_id))
                    .values(deleted_at=datetime.datetime.now(datetime.UTC))
                )
            elif kind == "foreign":
                other = User(
                    email="observation-other@example.com",
                    display_name="합성 다른 사용자",
                    password_hash="unused-test-hash",
                )
                session.add(other)
                await session.flush()
                await session.execute(
                    update(model).where(model.id == uuid.UUID(entity_id)).values(user_id=other.id)
                )

    assert api_client.portal is not None
    api_client.portal.call(invalidate)
    if kind == "missing":
        if entity == "location":
            data["locations"][0] = str(uuid.uuid4())
        else:
            data[entity]["id"] = str(uuid.uuid4())
    response = api_client.patch(
        correction_path(prefix, data),
        json={
            "observed_location_id": data["locations"][0],
            "expected_observed_location_id": data["locations"][1],
        },
    )
    assert response.status_code == 404, response.text
