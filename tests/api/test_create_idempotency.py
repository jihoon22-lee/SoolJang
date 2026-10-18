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
