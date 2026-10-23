"""수량 축소·늦은 종료 명령이 기존 시음과 확정된 병 상태를 보존한다."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.api.test_history_corrections import _correct, _tasting
from tests.api.test_sync import _batch, _op
from tests.api.test_tastings import _create_product_with_bottle


def _tasting_on_unopened_bottle(
    client: TestClient, prefix: str, *, quantity: int
) -> tuple[dict[str, Any], dict[str, Any]]:
    data = _create_product_with_bottle(client, prefix, quantity=quantity)
    row = _tasting(client, prefix, data["bottles"][0]["id"])
    target = client.get(f"{prefix}/bottles/{data['bottles'][-1]['id']}").json()
    command = _correct(row, bottle_id=target["id"])
    command["expected_bottles"].append({"id": target["id"], "revision": target["revision"]})
    response = client.post(f"{prefix}/tastings/{row['id']}:correct", json=command)
    assert response.status_code == 200, response.text
    assert response.json()["bottle"]["status"] == "unopened"
    return data, response.json()


def test_shrinking_rejects_tasted_unopened_bottle_without_changing_purchase_or_history(
    api_client: TestClient, prefix: str
) -> None:
    data, tasting = _tasting_on_unopened_bottle(api_client, prefix, quantity=2)
    path = f"{prefix}/purchases/{data['purchase_id']}"
    before = api_client.get(f"{prefix}/purchases").json()
    bottles = api_client.get(f"{path}/bottles").json()
    history = api_client.get(f"{path}/history").json()

    response = api_client.patch(path, json={"quantity": 1, "unit_paid_price": "45000"})

    assert response.status_code == 409, response.text
    assert api_client.get(f"{prefix}/purchases").json() == before
    assert api_client.get(f"{path}/bottles").json() == bottles
    assert api_client.get(f"{path}/history").json() == history
    assert api_client.get(f"{prefix}/tastings/{tasting['id']}").json() == tasting


def test_shrinking_removes_only_untasted_unopened_bottles_even_with_a_higher_tasted_label(
    api_client: TestClient, prefix: str
) -> None:
    data, tasting = _tasting_on_unopened_bottle(api_client, prefix, quantity=3)
    path = f"{prefix}/purchases/{data['purchase_id']}"

    response = api_client.patch(path, json={"quantity": 2})

    assert response.status_code == 200, response.text
    assert response.json()["quantity"] == response.json()["bottle_count"] == 2
    current = api_client.get(f"{path}/bottles").json()
    assert [bottle["id"] for bottle in current] == [
        data["bottles"][0]["id"],
        data["bottles"][2]["id"],
    ]
    saved = api_client.get(f"{prefix}/tastings/{tasting['id']}")
    assert saved.status_code == 200, saved.text
    assert saved.json()["bottle_id"] == tasting["bottle_id"]
    assert saved.json()["updated_at"] == tasting["updated_at"]


def test_shrinking_allows_a_bottle_with_only_deleted_tastings_and_prevents_orphan_restore(
    api_client: TestClient, prefix: str
) -> None:
    data, tasting = _tasting_on_unopened_bottle(api_client, prefix, quantity=2)
    path = f"{prefix}/tastings/{tasting['id']}"
    removed = api_client.request(
        "DELETE",
        path,
        json={"request_id": str(uuid.uuid4()), "expected_updated_at": tasting["updated_at"]},
    )
    assert removed.status_code == 200, removed.text

    response = api_client.patch(f"{prefix}/purchases/{data['purchase_id']}", json={"quantity": 1})

    assert response.status_code == 200, response.text
    restored = api_client.post(
        f"{path}:restore",
        json={
            "request_id": str(uuid.uuid4()),
            "expected_updated_at": removed.json()["updated_at"],
        },
    )
    assert restored.status_code == 409, restored.text
    assert api_client.get(f"{prefix}/tastings/deleted").json()["items"] == []


def _finish_payload(action: str, day: str) -> dict[str, str]:
    return {"finished_on": day} if action == "finish" else {"on": day, "note": "원래 처분 메모"}


@pytest.mark.parametrize("first", ["finish", "gift", "sell"])
@pytest.mark.parametrize("late", ["finish", "gift", "sell"])
def test_late_online_terminal_action_preserves_the_first_state_date_and_history(
    api_client: TestClient, prefix: str, first: str, late: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    path = f"{prefix}/bottles/{data['bottles'][0]['id']}"
    completed = api_client.post(f"{path}:{first}", json=_finish_payload(first, "2026-10-05"))
    assert completed.status_code == 200, completed.text
    history = api_client.get(f"{path}/history").json()

    response = api_client.post(f"{path}:{late}", json=_finish_payload(late, "2026-10-06"))

    assert response.status_code == 409, response.text
    assert api_client.get(path).json() == completed.json()
    assert api_client.get(f"{path}/history").json() == history


@pytest.mark.parametrize("first,late", [("finish", "finish"), ("gift", "sell"), ("sell", "gift")])
def test_late_offline_terminal_action_conflicts_and_other_commands_continue(
    api_client: TestClient, prefix: str, first: str, late: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    bottle_id = data["bottles"][0]["id"]
    path = f"{prefix}/bottles/{bottle_id}"
    completed = api_client.post(f"{path}:{first}", json=_finish_payload(first, "2026-10-05"))
    assert completed.status_code == 200, completed.text
    history = api_client.get(f"{path}/history").json()
    commands = [
        _op(
            entity="bottle",
            entity_id=uuid.UUID(bottle_id),
            op="action",
            action=late,
            fields=_finish_payload(late, "2026-10-06"),
        ),
        _op(entity="vendor", op="create", fields={"name": "계속 처리할 구매처"}),
    ]

    result = _batch(api_client, prefix, commands)

    assert [row["status"] for row in result["results"]] == ["conflict", "applied"]
    assert result["stopped"] is False
    assert api_client.get(path).json() == completed.json()
    assert api_client.get(f"{path}/history").json() == history
    replay = _batch(api_client, prefix, commands)
    assert [row["status"] for row in replay["results"]] == ["conflict", "applied"]
    assert len(api_client.get(f"{prefix}/vendors").json()) == 1


@pytest.mark.parametrize("action", ["finish", "gift", "sell"])
def test_replaying_successful_terminal_command_returns_original_result_without_new_history(
    api_client: TestClient, prefix: str, action: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    bottle_id = data["bottles"][0]["id"]
    commands = [
        _op(
            entity="bottle",
            entity_id=uuid.UUID(bottle_id),
            op="action",
            action=action,
            fields=_finish_payload(action, "2026-10-05"),
        )
    ]
    first = _batch(api_client, prefix, commands)
    assert first["results"][0]["status"] == "applied"
    path = f"{prefix}/bottles/{bottle_id}"
    bottle = api_client.get(path).json()
    history = api_client.get(f"{path}/history").json()

    replay = _batch(api_client, prefix, commands)

    assert replay["results"][0]["status"] == "applied"
    assert replay["results"][0]["snapshot"] == first["results"][0]["snapshot"]
    assert api_client.get(path).json() == bottle
    assert api_client.get(f"{path}/history").json() == history
