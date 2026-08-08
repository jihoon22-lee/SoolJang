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


def test_variety_no_op_save_does_not_duplicate_the_link_in_pull(
    api_client: TestClient, prefix: str
) -> None:
    """`variety_names` 를 바꾸지 않고 저장해도 풀에 새 `product_variety` 행이 생기면 안
    된다. 예전에는 저장할 때마다 연결을 hard delete 뒤 새 id 로 다시 만들어서, 삭제가
    `deleted_at` 없이 사라져 클라이언트 로컬 미러에 옛 연결이 계속 남았다 — 실사용 중
    "품종·스타일" 값이 저장할 때마다 증식하는 결함으로 발견됐다."""
    product = api_client.post(
        f"{prefix}/products", json={"name": "증식 재현", "variety_names": ["레드", "스위트"]}
    ).json()

    before = _pull(api_client, prefix)
    link_ids = {
        row["id"]
        for row in before["changes"]["product_variety"]
        if row["product_id"] == product["id"]
    }
    assert len(link_ids) == 2

    for _ in range(2):
        response = api_client.patch(
            f"{prefix}/products/{product['id']}", json={"variety_names": ["레드", "스위트"]}
        )
        assert response.json()["varieties"] == ["레드", "스위트"]

    after = _pull(api_client, prefix, since=before["next_cursor"])
    changed = [
        row for row in after["changes"]["product_variety"] if row["product_id"] == product["id"]
    ]
    assert changed == []


def test_variety_removed_then_readded_restores_the_same_link(
    api_client: TestClient, prefix: str
) -> None:
    """품종을 뺐다가 같은 이름으로 다시 넣으면 새 연결이 아니라 소프트 삭제됐던 기존
    연결을 복원해야 한다 — 그래야 삭제가 `deleted_at` 로 남아 동기화가 전파된다."""
    product = api_client.post(
        f"{prefix}/products", json={"name": "복원 재현", "variety_names": ["레드", "스위트"]}
    ).json()

    before = _pull(api_client, prefix)
    variety_name = {row["id"]: row["name"] for row in before["changes"]["variety"]}
    sweet_link_id = next(
        row["id"]
        for row in before["changes"]["product_variety"]
        if row["product_id"] == product["id"] and variety_name[row["variety_id"]] == "스위트"
    )

    remove = api_client.patch(
        f"{prefix}/products/{product['id']}", json={"variety_names": ["레드"]}
    )
    assert remove.json()["varieties"] == ["레드"]

    after_remove = _pull(api_client, prefix, since=before["next_cursor"])
    removed_row = next(
        row for row in after_remove["changes"]["product_variety"] if row["id"] == sweet_link_id
    )
    assert removed_row["deleted_at"] is not None

    readd = api_client.patch(
        f"{prefix}/products/{product['id']}", json={"variety_names": ["레드", "스위트"]}
    )
    assert readd.json()["varieties"] == ["레드", "스위트"]

    after_readd = _pull(api_client, prefix, since=after_remove["next_cursor"])
    restored_row = next(
        row for row in after_readd["changes"]["product_variety"] if row["id"] == sweet_link_id
    )
    assert restored_row["deleted_at"] is None


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


def test_구매_병수가_정수가_아니면_배치_전체를_안_죽이고_해당_작업만_실패한다(
    api_client: TestClient, prefix: str
) -> None:
    """실사용 중 발견된 결함의 재현: `ProductForm` 병수 입력에 `step` 제한이 없어 "2.5"
    가 입력될 수 있었다. 오프라인이면 병 id 2개(`Array.from({length:2.5})`)와 서버로
    보내는 `quantity: 2.5` 가 어긋난 채로 도착한다 — 이게 그대로 DB 에 들어가려다
    `DataError` 를 내며 배치 전체를 죽이면 안 되고(§9.13 과 별개로 세션 롤백 문제),
    이 작업 하나만 실패로 기록하고 앞서 성공한 카테고리·제품·규격은 그대로 남아야 한다."""
    category_id = uuid.uuid4()
    product_id = uuid.uuid4()
    sku_id = uuid.uuid4()

    result = _batch(
        api_client,
        prefix,
        [
            _op(entity="category", op="create", entity_id=category_id, fields={"name": "위스키"}),
            _op(
                entity="product",
                op="create",
                entity_id=product_id,
                fields={"name": "병수 오류 테스트 위스키", "category_id": str(category_id)},
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
                fields={"sku_id": str(sku_id), "quantity": 2.5},
            ),
        ],
    )

    assert result["stopped"] is True
    assert [r["status"] for r in result["results"]] == ["applied", "applied", "applied", "failed"]
    assert "정수" in (result["results"][3]["detail"] or "")

    # 앞서 성공한 카테고리·제품·규격은 롤백되지 않는다.
    detail = api_client.get(f"{prefix}/products/{product_id}").json()
    assert detail["name"] == "병수 오류 테스트 위스키"
    # 실패한 구매 건이 만들어지지 않았으니 병도 없다.
    bottles = api_client.get(f"{prefix}/bottles").json()
    assert not any(b["sku_id"] == str(sku_id) for b in bottles)


def test_구매_병수_상한_초과는_거부된다(api_client: TestClient, prefix: str) -> None:
    product = api_client.post(
        f"{prefix}/products", json={"name": "병수 상한 테스트", "skus": [{"volume_ml": 500}]}
    ).json()
    sku_id = product["skus"][0]["id"]

    result = _batch(
        api_client,
        prefix,
        [_op(entity="purchase", op="create", fields={"sku_id": sku_id, "quantity": 1001})],
    )

    assert result["results"][0]["status"] == "failed"
    assert "1000" in (result["results"][0]["detail"] or "")


def test_규격_용량이_정수가_아니면_거부된다(api_client: TestClient, prefix: str) -> None:
    product = api_client.post(f"{prefix}/products", json={"name": "용량 오류 테스트"}).json()

    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="sku",
                op="create",
                fields={"product_id": product["id"], "volume_ml": 700.5},
            )
        ],
    )

    assert result["results"][0]["status"] == "failed"
    assert "정수" in (result["results"][0]["detail"] or "")


def test_제품_이름이_너무_길면_거부된다(api_client: TestClient, prefix: str) -> None:
    result = _batch(
        api_client,
        prefix,
        [_op(entity="product", op="create", fields={"name": "가" * 301})],
    )

    assert result["results"][0]["status"] == "failed"
    assert "300" in (result["results"][0]["detail"] or "")


def test_구매처_이름이_너무_길면_거부된다(api_client: TestClient, prefix: str) -> None:
    result = _batch(
        api_client,
        prefix,
        [_op(entity="vendor", op="create", fields={"name": "가" * 201})],
    )

    assert result["results"][0]["status"] == "failed"
    assert "200" in (result["results"][0]["detail"] or "")


def test_주종_이름이_너무_길면_거부된다(api_client: TestClient, prefix: str) -> None:
    result = _batch(
        api_client,
        prefix,
        [_op(entity="category", op="create", fields={"name": "가" * 121})],
    )

    assert result["results"][0]["status"] == "failed"
    assert "120" in (result["results"][0]["detail"] or "")


def test_타입이_안_맞는_값도_DataError로_배치_전체를_안_죽인다(
    api_client: TestClient, prefix: str
) -> None:
    """`vintage` 는 정수 컬럼인데 명시적 경계 검증이 없다(연도라 상한이 이미 넉넉하다) —
    문자열이 오면 DB 플러시 시점에 `DataError` 가 난다. `_bounded_int`/`_bounded_str` 로
    막지 못하는 필드에 대한 마지막 안전망(D107 의 IntegrityError 처리와 같은 종류)이
    실제로 동작하는지 확인한다."""
    ok_vendor_id = uuid.uuid4()
    never_sent_vendor_id = uuid.uuid4()

    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="vendor", op="create", entity_id=ok_vendor_id, fields={"name": "정상 구매처"}
            ),
            _op(
                entity="product",
                op="create",
                fields={"name": "이상한 빈티지 테스트", "vintage": "특급반"},
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
    detail = result["results"][1]["detail"]
    assert detail is not None
    assert "vintage" not in detail.lower() and "integer" not in detail.lower()

    vendors = api_client.get(f"{prefix}/vendors").json()
    assert any(v["id"] == str(ok_vendor_id) for v in vendors), "앞서 성공한 작업이 롤백되면 안 된다"
    assert not any(v["id"] == str(never_sent_vendor_id) for v in vendors)
