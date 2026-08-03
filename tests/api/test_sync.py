"""동기화 API 테스트 (`GET /sync`, `POST /sync/batch`, 충돌 확인 처리)."""

import uuid
from typing import Any

from fastapi.testclient import TestClient


def _op(
    *,
    entity: str,
    op: str,
    entity_id: uuid.UUID | None = None,
    idempotency_key: uuid.UUID | None = None,
    action: str | None = None,
    base_updated_at: str | None = None,
    fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    eid = entity_id or uuid.uuid4()
    return {
        "idempotency_key": str(idempotency_key or eid),
        "entity": entity,
        "op": op,
        "entity_id": str(eid),
        "action": action,
        "base_updated_at": base_updated_at,
        "fields": fields or {},
    }


def _batch(client: TestClient, prefix: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
    response = client.post(f"{prefix}/sync/batch", json={"operations": operations})
    assert response.status_code == 200, response.text
    return response.json()


def _pull(client: TestClient, prefix: str, since: str | None = None) -> dict[str, Any]:
    params = {"since": since} if since else {}
    response = client.get(f"{prefix}/sync", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_sync_endpoints_require_auth(anon_client: TestClient, prefix: str) -> None:
    assert anon_client.get(f"{prefix}/sync").status_code == 401
    assert anon_client.post(f"{prefix}/sync/batch", json={"operations": []}).status_code == 401


def test_empty_pull_returns_empty_lists(api_client: TestClient, prefix: str) -> None:
    result = _pull(api_client, prefix)
    assert result["has_more"] is False
    assert result["next_cursor"] is None
    for entity in (
        "category",
        "producer",
        "variety",
        "product",
        "product_variety",
        "sku",
        "vendor",
        "purchase",
        "bottle",
        "tasting_session",
        "attachment",
        "conflict_log",
    ):
        assert result["changes"][entity] == []


def test_full_chain_create_and_pull(api_client: TestClient, prefix: str) -> None:
    """카테고리 → 제품 → 규격 → 구매(병 자동 생성)를 한 배치로 만들고 풀로 확인한다."""
    category_id = uuid.uuid4()
    product_id = uuid.uuid4()
    sku_id = uuid.uuid4()
    purchase_id = uuid.uuid4()
    bottle_id = uuid.uuid4()

    result = _batch(
        api_client,
        prefix,
        [
            _op(entity="category", op="create", entity_id=category_id, fields={"name": "위스키"}),
            _op(
                entity="product",
                op="create",
                entity_id=product_id,
                fields={"name": "오프라인 위스키", "category_id": str(category_id)},
            ),
            _op(
                entity="sku",
                op="create",
                entity_id=sku_id,
                fields={"product_id": str(product_id), "volume_ml": 700},
            ),
            _op(
                entity="purchase",
                op="create",
                entity_id=purchase_id,
                fields={
                    "sku_id": str(sku_id),
                    "quantity": 1,
                    "unit_list_price": "50000",
                    "bottle_ids": [str(bottle_id)],
                },
            ),
        ],
    )

    assert result["stopped"] is False
    assert [r["status"] for r in result["results"]] == ["applied"] * 4

    detail = api_client.get(f"{prefix}/products/{product_id}").json()
    assert detail["name"] == "오프라인 위스키"
    assert detail["metrics"]["purchased_count"] == 1
    assert detail["metrics"]["avg_list_price"] == "50000.00"

    bottles = api_client.get(f"{prefix}/bottles").json()
    assert any(b["id"] == str(bottle_id) for b in bottles)

    pulled = _pull(api_client, prefix)
    assert any(row["id"] == str(category_id) for row in pulled["changes"]["category"])
    assert any(row["id"] == str(product_id) for row in pulled["changes"]["product"])
    assert any(row["id"] == str(sku_id) for row in pulled["changes"]["sku"])
    assert any(row["id"] == str(purchase_id) for row in pulled["changes"]["purchase"])
    assert any(row["id"] == str(bottle_id) for row in pulled["changes"]["bottle"])


def test_idempotent_resend_does_not_duplicate(api_client: TestClient, prefix: str) -> None:
    key = uuid.uuid4()
    vendor_id = uuid.uuid4()
    op = _op(
        entity="vendor",
        op="create",
        entity_id=vendor_id,
        idempotency_key=key,
        fields={"name": "재전송 테스트 구매처"},
    )

    first = _batch(api_client, prefix, [op])
    second = _batch(api_client, prefix, [op])

    assert first["results"][0]["status"] == "applied"
    assert second["results"][0]["status"] == "applied"
    assert first["results"][0]["snapshot"] == second["results"][0]["snapshot"]

    vendors = [v for v in api_client.get(f"{prefix}/vendors").json() if v["id"] == str(vendor_id)]
    assert len(vendors) == 1


def test_head_of_line_blocking_stops_batch_after_failure(
    api_client: TestClient, prefix: str
) -> None:
    vendor_id = uuid.uuid4()
    missing_sku_id = uuid.uuid4()
    never_sent_vendor_id = uuid.uuid4()

    result = _batch(
        api_client,
        prefix,
        [
            _op(entity="vendor", op="create", entity_id=vendor_id, fields={"name": "정상 구매처"}),
            _op(
                entity="purchase",
                op="create",
                fields={"sku_id": str(missing_sku_id), "quantity": 1},
            ),
            _op(
                entity="vendor",
                op="create",
                entity_id=never_sent_vendor_id,
                fields={"name": "실행되지 않아야 함"},
            ),
        ],
    )

    assert result["stopped"] is True
    assert [r["status"] for r in result["results"]] == ["applied", "failed"]

    vendors = api_client.get(f"{prefix}/vendors").json()
    assert any(v["id"] == str(vendor_id) for v in vendors)
    assert not any(v["id"] == str(never_sent_vendor_id) for v in vendors)


def test_db_constraint_violation_fails_only_that_op_and_keeps_prior_ops(
    api_client: TestClient, prefix: str
) -> None:
    """DB 제약(여기선 구매처 이름 UNIQUE) 위반은 `IntegrityError` 로 앱 검증을 거치지 않고
    바로 난다 — 이게 이 배치의 다른 작업까지 500 으로 함께 죽이면 안 되고, 이 배치에서
    이미 성공한 앞선 작업도 롤백되면 안 된다."""
    existing = api_client.post(f"{prefix}/vendors", json={"name": "이미 있는 구매처"})
    assert existing.status_code == 201, existing.text

    ok_vendor_id = uuid.uuid4()
    never_sent_vendor_id = uuid.uuid4()

    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="vendor", op="create", entity_id=ok_vendor_id, fields={"name": "정상 구매처"}
            ),
            _op(entity="vendor", op="create", fields={"name": "이미 있는 구매처"}),
            _op(
                entity="vendor",
                op="create",
                entity_id=never_sent_vendor_id,
                fields={"name": "실행되지 않아야 함"},
            ),
        ],
    )

    assert result["stopped"] is True
    assert [r["status"] for r in result["results"]] == ["applied", "failed"]
    # 원인(제약 이름·테이블명)을 그대로 노출하지 않는다.
    detail = result["results"][1]["detail"]
    assert detail is not None
    assert "constraint" not in detail.lower() and "uq_vendor" not in detail

    vendors = api_client.get(f"{prefix}/vendors").json()
    assert any(v["id"] == str(ok_vendor_id) for v in vendors), "앞서 성공한 작업이 롤백되면 안 된다"
    assert not any(v["id"] == str(never_sent_vendor_id) for v in vendors)


def test_resending_a_failed_op_reuses_the_result_without_rerunning_it(
    api_client: TestClient, prefix: str
) -> None:
    """실패한 작업도 receipt 를 남겨, 같은 `idempotency_key` 로 재전송하면 도메인 검증을
    다시 돌리지 않고 같은 실패 결과를 재사용해야 한다(멱등성 — 성공·충돌과 동일)."""
    existing = api_client.post(f"{prefix}/vendors", json={"name": "이미 있는 구매처"})
    assert existing.status_code == 201, existing.text

    op = _op(entity="vendor", op="create", fields={"name": "이미 있는 구매처"})

    first = _batch(api_client, prefix, [op])
    second = _batch(api_client, prefix, [op])

    assert first["results"][0]["status"] == "failed"
    assert second["results"][0]["status"] == "failed"
    assert first["results"][0]["detail"] == second["results"][0]["detail"]
    assert second["stopped"] is True

    # 재실행되지 않았다 — 이름이 겹치는 구매처가 여전히 하나뿐이다.
    vendors = [
        v for v in api_client.get(f"{prefix}/vendors").json() if v["name"] == "이미 있는 구매처"
    ]
    assert len(vendors) == 1


def test_lww_conflict_keeps_server_value_and_logs(api_client: TestClient, prefix: str) -> None:
    created = api_client.post(f"{prefix}/vendors", json={"name": "충돌 테스트 구매처"})
    assert created.status_code == 201, created.text
    vendor = created.json()
    vendor_id = vendor["id"]
    stale_base = "2020-01-01T00:00:00Z"

    updated = api_client.patch(f"{prefix}/vendors/{vendor_id}", json={"note": "서버에서 수정"})
    assert updated.status_code == 200, updated.text

    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="vendor",
                op="update",
                entity_id=uuid.UUID(vendor_id),
                base_updated_at=stale_base,
                fields={"note": "오프라인에서 수정"},
            )
        ],
    )

    assert result["results"][0]["status"] == "conflict"

    current = api_client.get(f"{prefix}/vendors").json()
    matched = next(v for v in current if v["id"] == vendor_id)
    assert matched["note"] == "서버에서 수정"

    pulled = _pull(api_client, prefix)
    assert len(pulled["changes"]["conflict_log"]) == 1
    assert pulled["changes"]["conflict_log"][0]["entity_id"] == vendor_id


def test_soft_delete_propagates_in_pull(api_client: TestClient, prefix: str) -> None:
    """create·delete 는 같은 `entity_id` 를 가리키지만 서로 다른 `idempotency_key` 를
    써야 한다 — 작업(operation) 하나마다 키가 새로 생기는 게 정상이다. 같은 키를 쓰면
    delete 가 create 의 재전송으로 오인되어 멱등 처리로 건너뛰어진다(의도된 동작)."""
    vendor_id = uuid.uuid4()
    _batch(
        api_client,
        prefix,
        [_op(entity="vendor", op="create", entity_id=vendor_id, fields={"name": "삭제될 구매처"})],
    )
    _batch(
        api_client,
        prefix,
        [_op(entity="vendor", op="delete", entity_id=vendor_id, idempotency_key=uuid.uuid4())],
    )

    pulled = _pull(api_client, prefix)
    row = next(r for r in pulled["changes"]["vendor"] if r["id"] == str(vendor_id))
    assert row["deleted_at"] is not None


def test_bottle_action_and_tasting_action(api_client: TestClient, prefix: str) -> None:
    product = api_client.post(
        f"{prefix}/products", json={"name": "액션 테스트 술", "skus": [{"volume_ml": 500}]}
    ).json()
    sku_id = product["skus"][0]["id"]
    purchase = api_client.post(f"{prefix}/purchases", json={"sku_id": sku_id, "quantity": 1}).json()
    bottles = api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()
    bottle_id = bottles[0]["id"]

    open_result = _batch(
        api_client,
        prefix,
        [_op(entity="bottle", op="action", entity_id=uuid.UUID(bottle_id), action="open")],
    )
    assert open_result["results"][0]["status"] == "applied"

    tasting_id = uuid.uuid4()
    tasting_result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="tasting_session",
                op="action",
                entity_id=tasting_id,
                action="record_tasting",
                fields={"bottle_id": bottle_id, "tasted_on": "2026-01-01", "poured_ml": 100},
            )
        ],
    )
    assert tasting_result["results"][0]["status"] == "applied"

    refreshed = api_client.get(f"{prefix}/bottles/{bottle_id}").json()
    assert refreshed["status"] == "open"
    assert refreshed["remaining_ml"] == 400


def test_bottle_unopen_action(api_client: TestClient, prefix: str) -> None:
    product = api_client.post(
        f"{prefix}/products", json={"name": "되돌리기 테스트 술", "skus": [{"volume_ml": 500}]}
    ).json()
    sku_id = product["skus"][0]["id"]
    purchase = api_client.post(f"{prefix}/purchases", json={"sku_id": sku_id, "quantity": 1}).json()
    bottles = api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()
    bottle_id = bottles[0]["id"]

    _batch(
        api_client,
        prefix,
        [_op(entity="bottle", op="action", entity_id=uuid.UUID(bottle_id), action="open")],
    )
    unopen_result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="bottle",
                op="action",
                entity_id=uuid.UUID(bottle_id),
                idempotency_key=uuid.uuid4(),
                action="unopen",
            )
        ],
    )
    assert unopen_result["results"][0]["status"] == "applied"

    refreshed = api_client.get(f"{prefix}/bottles/{bottle_id}").json()
    assert refreshed["status"] == "unopened"
    assert refreshed["remaining_ml"] is None


def test_category_parent_change_via_sync_is_rejected(api_client: TestClient, prefix: str) -> None:
    child = api_client.post(f"{prefix}/categories", json={"name": "자식"}).json()
    other_parent = api_client.post(f"{prefix}/categories", json={"name": "다른 부모"}).json()

    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="category",
                op="update",
                entity_id=uuid.UUID(child["id"]),
                fields={"parent_id": other_parent["id"]},
            )
        ],
    )

    assert result["results"][0]["status"] == "failed"
