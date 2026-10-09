"""조건부 되돌리기: 원 작업 이후 같은 병의 변경만 되돌리기를 무효화한다."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.infrastructure.database.models import OutboxReceipt
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_sync import _batch, _op
from tests.api.test_tastings import _create_product_with_bottle


def _action(bottle_id: str, action: str, **fields: Any) -> dict[str, Any]:
    return _op(
        entity="bottle",
        op="action",
        entity_id=uuid.UUID(bottle_id),
        idempotency_key=uuid.uuid4(),
        action=action,
        fields=fields,
    )


def _bottle(client: TestClient, prefix: str, bottle_id: str) -> dict[str, Any]:
    return client.get(f"{prefix}/bottles/{bottle_id}").json()


@pytest.mark.parametrize("action", ["open", "finish", "gift", "sell", "set_remaining"])
def test_undo_restores_exact_state_and_retries_once(
    api_client: TestClient, prefix: str, action: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    bottle_id = data["bottles"][0]["id"]
    if action != "open":
        api_client.post(
            f"{prefix}/bottles/{bottle_id}:open",
            json={"remaining_ml": 415, "opened_on": "2026-10-01"},
        )
    before = _bottle(api_client, prefix, bottle_id)
    original = _action(
        bottle_id, action, remaining_ml=250, note="추가 메모", expected_revision=before["revision"]
    )
    applied = _batch(api_client, prefix, [original])["results"][0]
    undo = _action(
        bottle_id,
        "undo",
        origin_operation_id=original["idempotency_key"],
        expected_revision=applied["snapshot"]["revision"],
    )
    result = _batch(api_client, prefix, [undo])
    assert result["results"][0]["status"] == "applied"
    assert _batch(api_client, prefix, [undo]) == result
    restored = _bottle(api_client, prefix, bottle_id)
    assert restored["revision"] != before["revision"]
    assert {k: v for k, v in restored.items() if k != "revision"} == {
        k: v for k, v in before.items() if k != "revision"
    }
    history = api_client.get(f"{prefix}/bottles/{bottle_id}/history").json()
    assert [row["action"] for row in history].count("undo") == 1
    # Private restoration data never travels as part of the public entity snapshot.
    assert "_undo" not in _batch(api_client, prefix, [original])["results"][0]["snapshot"]


@pytest.mark.parametrize("poured_ml", [None, 30])
def test_tasting_invalidates_origin_even_with_current_revision(
    api_client: TestClient, prefix: str, poured_ml: int | None
) -> None:
    bottle_id = _create_product_with_bottle(api_client, prefix)["bottles"][0]["id"]
    origin = _action(bottle_id, "open", opened_on="2026-10-01")
    opened = _batch(api_client, prefix, [origin])["results"][0]["snapshot"]
    tasting = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": bottle_id, "tasted_on": "2026-10-02", "poured_ml": poured_ml},
    )
    assert tasting.status_code == 201
    after = _bottle(api_client, prefix, bottle_id)
    assert after["revision"] != opened["revision"]
    undo = _action(
        bottle_id,
        "undo",
        origin_operation_id=origin["idempotency_key"],
        expected_revision=after["revision"],
    )
    failed = _batch(api_client, prefix, [undo])
    assert failed["results"][0]["status"] == "failed"
    assert failed["stopped"] is True
    assert _bottle(api_client, prefix, bottle_id) == after
    assert (
        api_client.post(
            f"{prefix}/bottles/{bottle_id}:unopen", json={"expected_revision": after["revision"]}
        ).status_code
        == 409
    )


def test_other_bottle_changes_do_not_block_undo_and_receipt_cannot_cross_bottles(
    api_client: TestClient, prefix: str
) -> None:
    bottles = _create_product_with_bottle(api_client, prefix, quantity=2)["bottles"]
    first, second = [row["id"] for row in bottles]
    origin = _action(first, "open")
    other = _action(second, "open")
    _batch(api_client, prefix, [origin, other])
    foreign = _action(
        second,
        "undo",
        origin_operation_id=origin["idempotency_key"],
        expected_operation_id=other["idempotency_key"],
    )
    assert _batch(api_client, prefix, [foreign])["results"][0]["status"] == "failed"
    undo = _action(
        first,
        "undo",
        origin_operation_id=origin["idempotency_key"],
        expected_operation_id=origin["idempotency_key"],
    )
    assert _batch(api_client, prefix, [undo])["results"][0]["status"] == "applied"
    assert _bottle(api_client, prefix, second)["status"] == "open"


def test_offline_chain_uses_each_operation_revision_within_one_transaction(
    api_client: TestClient, prefix: str
) -> None:
    bottle_id = _create_product_with_bottle(api_client, prefix)["bottles"][0]["id"]
    opened = _action(bottle_id, "open")
    adjusted = _action(
        bottle_id,
        "set_remaining",
        remaining_ml=350,
        expected_operation_id=opened["idempotency_key"],
    )
    undo = _action(
        bottle_id,
        "undo",
        origin_operation_id=adjusted["idempotency_key"],
        expected_operation_id=adjusted["idempotency_key"],
    )
    result = _batch(api_client, prefix, [opened, adjusted, undo])
    assert [row["status"] for row in result["results"]] == ["applied"] * 3
    assert len({row["effects"]["bottle"]["revision"] for row in result["results"]}) == 3
    assert _bottle(api_client, prefix, bottle_id)["remaining_ml"] == 750
    stale = _action(
        bottle_id,
        "undo",
        origin_operation_id=opened["idempotency_key"],
        expected_operation_id=undo["idempotency_key"],
    )
    assert _batch(api_client, prefix, [stale])["results"][0]["status"] == "failed"


@pytest.mark.parametrize("action", ["unopen", "reopen", "set_remaining"])
def test_legacy_and_stale_reversals_fail_without_mutating_or_dropping_next_command(
    api_client: TestClient, prefix: str, action: str
) -> None:
    bottle_id = _create_product_with_bottle(api_client, prefix)["bottles"][0]["id"]
    api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
    before = _bottle(api_client, prefix, bottle_id)
    legacy = _action(bottle_id, action, remaining_ml=200)
    next_op = _action(bottle_id, "finish")
    rejected = _batch(api_client, prefix, [legacy, next_op])
    assert rejected["stopped"] is True
    assert len(rejected["results"]) == 1
    assert rejected["results"][0]["status"] == "failed"
    assert _batch(api_client, prefix, [legacy, next_op]) == rejected
    endpoint = "remaining" if action == "set_remaining" else action
    assert (
        api_client.post(
            f"{prefix}/bottles/{bottle_id}:{endpoint}", json={"remaining_ml": 200}
        ).status_code
        == 409
    )
    assert (
        api_client.post(
            f"{prefix}/bottles/{bottle_id}:{endpoint}",
            json={"remaining_ml": 200, "expected_revision": str(uuid.uuid4())},
        ).status_code
        == 409
    )
    assert _bottle(api_client, prefix, bottle_id) == before


def test_tasting_effect_supports_guarded_remaining_in_same_batch(
    api_client: TestClient, prefix: str
) -> None:
    bottle_id = _create_product_with_bottle(api_client, prefix)["bottles"][0]["id"]
    tasting = _op(
        entity="tasting_session",
        op="action",
        action="record_tasting",
        fields={"bottle_id": bottle_id, "tasted_on": "2026-10-01", "poured_ml": 30},
    )
    correction = _action(
        bottle_id,
        "set_remaining",
        remaining_ml=650,
        expected_operation_id=tasting["idempotency_key"],
    )
    results = _batch(api_client, prefix, [tasting, correction])["results"]
    assert [row["status"] for row in results] == ["applied", "applied"]
    assert results[0]["effects"]["bottle"]["remaining_ml"] == 720
    assert results[1]["effects"]["bottle"]["remaining_ml"] == 650
    assert _batch(api_client, prefix, [tasting])["results"][0] == results[0]


@pytest.mark.parametrize("receipt_kind", ["missing", "foreign", "expired", "legacy"])
def test_undo_rejects_unverifiable_original_receipt(
    api_client: TestClient, prefix: str, receipt_kind: str
) -> None:
    bottle_id = _create_product_with_bottle(api_client, prefix)["bottles"][0]["id"]
    original = _action(bottle_id, "open")
    _batch(api_client, prefix, [original])
    before = _bottle(api_client, prefix, bottle_id)

    async def alter_receipt() -> None:
        async with get_session_factory().begin() as session:
            receipt = await session.get(OutboxReceipt, uuid.UUID(original["idempotency_key"]))
            assert receipt is not None
            if receipt_kind == "foreign":
                receipt.user_id = uuid.uuid4()
            elif receipt_kind == "expired":
                receipt.response_snapshot = {"receipt_expired": True}
            else:
                receipt.response_snapshot = before

    if receipt_kind == "missing":
        original["idempotency_key"] = str(uuid.uuid4())
    else:
        assert api_client.portal is not None
        api_client.portal.call(alter_receipt)
    undo = _action(
        bottle_id,
        "undo",
        origin_operation_id=original["idempotency_key"],
        expected_revision=before["revision"],
    )
    assert _batch(api_client, prefix, [undo])["results"][0]["status"] == "failed"
    assert _bottle(api_client, prefix, bottle_id) == before


def test_purchase_split_invalidates_undo_after_bottle_changes_purchase(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix, quantity=2)
    bottle_id = data["bottles"][0]["id"]
    original = _action(bottle_id, "open")
    previous = _batch(api_client, prefix, [original])["results"][0]["snapshot"]
    split = api_client.post(
        f"{prefix}/purchases/{data['purchase_id']}:split",
        json={"parts": [{"quantity": 1}, {"quantity": 1}]},
    )
    assert split.status_code == 200, split.text
    current = _bottle(api_client, prefix, bottle_id)
    assert current["purchase_id"] != previous["purchase_id"]
    assert current["revision"] != previous["revision"]
    undo = _action(
        bottle_id,
        "undo",
        origin_operation_id=original["idempotency_key"],
        expected_revision=current["revision"],
    )
    assert _batch(api_client, prefix, [undo])["results"][0]["status"] == "failed"
    assert _bottle(api_client, prefix, bottle_id) == current
