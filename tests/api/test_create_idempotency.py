"""응답을 잃은 온라인 생성 재전송은 같은 제품·구매를 돌려준다."""

import uuid

from fastapi.testclient import TestClient


def _product(client: TestClient, prefix: str, request_id: str, name: str = "멱등 위스키") -> dict:
    response = client.post(
        f"{prefix}/products",
        json={"name": name, "skus": [{"volume_ml": 700}], "request_id": request_id},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_retried_product_create_with_same_request_id_returns_same_product(
    api_client: TestClient, prefix: str
) -> None:
    request_id = str(uuid.uuid4())
    first = _product(api_client, prefix, request_id)
    second = _product(api_client, prefix, request_id)

    assert second["id"] == first["id"]
    assert [sku["id"] for sku in second["skus"]] == [sku["id"] for sku in first["skus"]]
    names = [item["name"] for item in api_client.get(f"{prefix}/products").json()["items"]]
    assert names.count("멱등 위스키") == 1


def test_product_request_id_reused_for_different_name_conflicts(
    api_client: TestClient, prefix: str
) -> None:
    request_id = str(uuid.uuid4())
    _product(api_client, prefix, request_id)
    response = api_client.post(
        f"{prefix}/products", json={"name": "다른 술", "request_id": request_id}
    )
    assert response.status_code == 409


def test_retried_purchase_create_does_not_duplicate_purchase_or_bottles(
    api_client: TestClient, prefix: str
) -> None:
    product = _product(api_client, prefix, str(uuid.uuid4()))
    sku_id = product["skus"][0]["id"]
    body = {"sku_id": sku_id, "quantity": 2, "request_id": str(uuid.uuid4())}

    first = api_client.post(f"{prefix}/purchases", json=body)
    second = api_client.post(f"{prefix}/purchases", json=body)

    assert first.status_code == second.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    purchases = api_client.get(f"{prefix}/purchases", params={"sku_id": sku_id}).json()
    assert len(purchases) == 1
    bottles = api_client.get(f"{prefix}/purchases/{first.json()['id']}/bottles").json()
    assert len(bottles) == 2


def test_purchase_request_id_reused_for_different_quantity_conflicts(
    api_client: TestClient, prefix: str
) -> None:
    product = _product(api_client, prefix, str(uuid.uuid4()))
    sku_id = product["skus"][0]["id"]
    request_id = str(uuid.uuid4())
    api_client.post(
        f"{prefix}/purchases", json={"sku_id": sku_id, "quantity": 1, "request_id": request_id}
    )
    response = api_client.post(
        f"{prefix}/purchases", json={"sku_id": sku_id, "quantity": 3, "request_id": request_id}
    )
    assert response.status_code == 409


def test_full_product_replay_with_producer_varieties_returns_same_product(
    api_client: TestClient, prefix: str
) -> None:
    body = {
        "name": "전체 재전송 위스키",
        "name_en": "Full Replay",
        "search_aliases": ["재전송"],
        "abv": "46.0",
        "age_years": "12",
        "producer_name": "  재전송 증류소 ",
        "variety_names": ["셰리 캐스크", "논칠"],
        "skus": [{"volume_ml": 700, "barcode": "8801234567893"}],
        "request_id": str(uuid.uuid4()),
    }
    first = api_client.post(f"{prefix}/products", json=body)
    second = api_client.post(f"{prefix}/products", json={**body, "abv": "46"})

    assert first.status_code == second.status_code == 201, second.text
    assert second.json()["id"] == first.json()["id"]


def test_product_request_id_reused_with_other_specification_conflicts(
    api_client: TestClient, prefix: str
) -> None:
    request_id = str(uuid.uuid4())
    _product(api_client, prefix, request_id)

    for changed in (
        {"skus": [{"volume_ml": 750}]},
        {"abv": "40"},
        {"producer_name": "다른 증류소"},
        {"variety_names": ["버번 캐스크"]},
    ):
        response = api_client.post(
            f"{prefix}/products",
            json={"name": "멱등 위스키", "skus": [{"volume_ml": 700}], "request_id": request_id}
            | changed,
        )
        assert response.status_code == 409, changed


def test_purchase_request_id_reused_with_other_content_conflicts(
    api_client: TestClient, prefix: str
) -> None:
    product = _product(api_client, prefix, str(uuid.uuid4()))
    body = {
        "sku_id": product["skus"][0]["id"],
        "quantity": 1,
        "purchased_on": "2026-10-01",
        "unit_paid_price": "50000",
        "create_bottles": False,
        "request_id": str(uuid.uuid4()),
    }
    assert api_client.post(f"{prefix}/purchases", json=body).status_code == 201
    same = api_client.post(f"{prefix}/purchases", json={**body, "unit_paid_price": "50000.00"})
    assert same.status_code == 201, same.text

    for changed in (
        {"create_bottles": True},
        {"unit_paid_price": "45000"},
        {"purchased_on": "2026-10-02"},
        {"discount_note": "쿠폰"},
    ):
        response = api_client.post(f"{prefix}/purchases", json=body | changed)
        assert response.status_code == 409, changed
        # 응답을 잃고 고쳐 보낸 사용자에게 앞선 구매가 이미 저장됐음을 알린다.
        assert "앞서 보낸 구매 등록이 이미 저장됐습니다" in response.json()["detail"]


def test_product_replay_is_judged_by_original_request_not_later_edits(
    api_client: TestClient, prefix: str
) -> None:
    """만든 뒤 고친 제품도 처음 요청의 재전송은 같은 제품이고, 고친 값으로 보낸 요청은 409다."""
    request_id = str(uuid.uuid4())
    original = _product(api_client, prefix, request_id)
    sku_id = original["skus"][0]["id"]
    assert api_client.patch(f"{prefix}/skus/{sku_id}", json={"volume_ml": 750}).status_code == 200
    assert (
        api_client.patch(f"{prefix}/products/{original['id']}", json={"abv": "43"}).status_code
        == 200
    )

    retried = _product(api_client, prefix, request_id)
    edited = api_client.post(
        f"{prefix}/products",
        json={
            "name": "멱등 위스키",
            "abv": "43",
            "skus": [{"volume_ml": 750}],
            "request_id": request_id,
        },
    )

    assert retried["id"] == original["id"]
    assert edited.status_code == 409


def test_purchase_replay_is_judged_by_original_request_not_later_edits(
    api_client: TestClient, prefix: str
) -> None:
    product = _product(api_client, prefix, str(uuid.uuid4()))
    body = {"sku_id": product["skus"][0]["id"], "quantity": 1, "request_id": str(uuid.uuid4())}
    created = api_client.post(f"{prefix}/purchases", json=body).json()
    assert (
        api_client.patch(f"{prefix}/purchases/{created['id']}", json={"quantity": 2}).status_code
        == 200
    )

    retried = api_client.post(f"{prefix}/purchases", json=body)
    edited = api_client.post(f"{prefix}/purchases", json=body | {"quantity": 2})

    assert retried.status_code == 201, retried.text
    assert retried.json()["id"] == created["id"]
    assert edited.status_code == 409
    bottles = api_client.get(f"{prefix}/purchases/{created['id']}/bottles").json()
    assert len(bottles) == 2


def test_product_request_id_reused_with_reordered_varieties_conflicts(
    api_client: TestClient, prefix: str
) -> None:
    """품종 순서는 저장되는 값(sort_order)이라 순서가 다른 요청은 같은 재전송이 아니다."""
    body = {"name": "품종 순서 위스키", "variety_names": ["셰리 캐스크", "버번 캐스크"]}
    request_id = str(uuid.uuid4())
    first = api_client.post(f"{prefix}/products", json=body | {"request_id": request_id})
    assert first.status_code == 201, first.text

    reordered = api_client.post(
        f"{prefix}/products",
        json=body | {"variety_names": ["버번 캐스크", "셰리 캐스크"], "request_id": request_id},
    )

    assert reordered.status_code == 409
