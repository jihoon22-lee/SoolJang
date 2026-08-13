"""구매처·구매 건 API 테스트.

`:split` 이 핵심이다. 레거시 임포트는 한 행을 합성 구매 건 하나로 만들 수밖에 없는데
실제로는 28행이 여러 구매처를 한 셀에 담고 있었다. 사용자가 나중에 쪼갤 수 있어야 임포트한
데이터가 정확해진다.
"""

from typing import Any

from fastapi.testclient import TestClient


def _post(client: TestClient, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = client.post(path, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _product_with_sku(
    client: TestClient, prefix: str, *, name: str = "테스트 술", volume_ml: int = 700
) -> tuple[dict[str, Any], str]:
    product = _post(
        client, f"{prefix}/products", {"name": name, "skus": [{"volume_ml": volume_ml}]}
    )
    return product, product["skus"][0]["id"]


def _vendor(client: TestClient, prefix: str, name: str, kind: str = "mart") -> dict[str, Any]:
    return _post(client, f"{prefix}/vendors", {"name": name, "kind": kind})


# --- 구매처 -----------------------------------------------------------------


def test_create_and_list_vendors(api_client: TestClient, prefix: str) -> None:
    _vendor(api_client, prefix, "가상마트 1호점")
    _vendor(api_client, prefix, "가상면세점", "duty_free")

    response = api_client.get(f"{prefix}/vendors")

    assert response.status_code == 200
    names = [item["name"] for item in response.json()]
    assert names == ["가상마트 1호점", "가상면세점"]


def test_vendor_purchase_count(api_client: TestClient, prefix: str) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    vendor = _vendor(api_client, prefix, "가상마트")
    for _ in range(2):
        _post(
            api_client,
            f"{prefix}/purchases",
            {"sku_id": sku_id, "vendor_id": vendor["id"], "quantity": 1},
        )

    listed = api_client.get(f"{prefix}/vendors").json()

    assert listed[0]["purchase_count"] == 2


def test_duplicate_vendor_name_returns_conflict(api_client: TestClient, prefix: str) -> None:
    _vendor(api_client, prefix, "가상마트")

    response = api_client.post(f"{prefix}/vendors", json={"name": "가상마트"})

    assert response.status_code == 409
    assert response.json()["type"].endswith("/conflict")


def test_vendor_in_use_cannot_be_deleted(api_client: TestClient, prefix: str) -> None:
    """구매처를 NULL 로 만들면 '어디서 샀는지 모름' 과 구분할 수 없게 된다."""
    _, sku_id = _product_with_sku(api_client, prefix)
    vendor = _vendor(api_client, prefix, "사용 중")
    _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": sku_id, "vendor_id": vendor["id"], "quantity": 1},
    )

    response = api_client.delete(f"{prefix}/vendors/{vendor['id']}")

    assert response.status_code == 409
    assert "구매 건" in response.json()["detail"]


def test_unused_vendor_can_be_deleted(api_client: TestClient, prefix: str) -> None:
    vendor = _vendor(api_client, prefix, "미사용")

    assert api_client.delete(f"{prefix}/vendors/{vendor['id']}").status_code == 204
    assert api_client.get(f"{prefix}/vendors").json() == []


def test_update_vendor_kind(api_client: TestClient, prefix: str) -> None:
    vendor = _vendor(api_client, prefix, "가상샵")

    response = api_client.patch(f"{prefix}/vendors/{vendor['id']}", json={"kind": "bottle_shop"})

    assert response.status_code == 200
    assert response.json()["kind"] == "bottle_shop"


def test_merge_vendor_reassigns_purchases_and_deletes_source(
    api_client: TestClient, prefix: str
) -> None:
    source = _vendor(api_client, prefix, "합칠 구매처")
    target = _vendor(api_client, prefix, "남길 구매처")
    _, sku_id = _product_with_sku(api_client, prefix)
    _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": sku_id, "vendor_id": source["id"], "quantity": 2},
    )

    response = api_client.post(
        f"{prefix}/vendors/{source['id']}:merge", json={"target_id": target["id"]}
    )

    assert response.status_code == 204, response.text
    listed = api_client.get(f"{prefix}/vendors").json()
    assert [vendor["name"] for vendor in listed] == ["남길 구매처"]
    # 원본의 구매 건 1건이 대상으로 옮겨진다.
    assert listed[0]["purchase_count"] == 1


def test_merge_vendor_rejects_self(api_client: TestClient, prefix: str) -> None:
    vendor = _vendor(api_client, prefix, "혼자 있는 구매처")

    response = api_client.post(
        f"{prefix}/vendors/{vendor['id']}:merge", json={"target_id": vendor["id"]}
    )

    assert response.status_code == 409


# --- 구매 건 ----------------------------------------------------------------


def test_same_product_records_multiple_purchases(api_client: TestClient, prefix: str) -> None:
    """엑셀에서 불가능했던 기록. 이 프로젝트의 존재 이유다."""
    product, sku_id = _product_with_sku(api_client, prefix)
    mart = _vendor(api_client, prefix, "가상마트")
    shop = _vendor(api_client, prefix, "가상보틀샵", "bottle_shop")

    _post(
        api_client,
        f"{prefix}/purchases",
        {
            "sku_id": sku_id,
            "vendor_id": mart["id"],
            "quantity": 2,
            "unit_list_price": "120000",
            "unit_paid_price": "100000",
            "purchased_on": "2026-03-01",
        },
    )
    _post(
        api_client,
        f"{prefix}/purchases",
        {
            "sku_id": sku_id,
            "vendor_id": shop["id"],
            "quantity": 1,
            "unit_list_price": "130000",
            "unit_paid_price": "128000",
            "purchased_on": "2026-06-15",
        },
    )

    purchases = api_client.get(f"{prefix}/purchases", params={"product_id": product["id"]}).json()

    assert len(purchases) == 2
    assert {item["vendor_name"] for item in purchases} == {"가상마트", "가상보틀샵"}
    assert {item["unit_paid_price"] for item in purchases} == {"100000.00", "128000.00"}
    # 총액은 단가에서 복원된다.
    totals = {item["paid_total"] for item in purchases}
    assert totals == {"200000.00", "128000.00"}


def test_bottles_are_created_per_quantity(api_client: TestClient, prefix: str) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 3})

    bottles = api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()

    assert [bottle["label_no"] for bottle in bottles] == [1, 2, 3]
    assert all(bottle["status"] == "unopened" for bottle in bottles)
    assert purchase["bottle_count"] == 3


def test_create_bottles_can_be_disabled(api_client: TestClient, prefix: str) -> None:
    """임포트는 상태별 개수를 직접 지정하므로 자동 생성을 끌 수 있어야 한다."""
    _, sku_id = _product_with_sku(api_client, prefix)

    purchase = _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": sku_id, "quantity": 3, "create_bottles": False},
    )

    assert purchase["bottle_count"] == 0


def test_foreign_purchase_requires_fx_rate(api_client: TestClient, prefix: str) -> None:
    """환율 없이 외화 가격만 저장하면 원화 환산을 재현할 수 없다."""
    _, sku_id = _product_with_sku(api_client, prefix)

    response = (
        api_client.post(
            f"{prefix}/purchases",
            {"sku_id": sku_id, "quantity": 1, "currency": "USD", "foreign_unit_price": "46.67"},
        )
        if False
        else api_client.post(
            f"{prefix}/purchases",
            json={
                "sku_id": sku_id,
                "quantity": 1,
                "currency": "USD",
                "foreign_unit_price": "46.67",
            },
        )
    )

    assert response.status_code == 422
    assert response.json()["type"].endswith("/validation")


def test_foreign_purchase_with_rate_is_accepted(api_client: TestClient, prefix: str) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)

    purchase = _post(
        api_client,
        f"{prefix}/purchases",
        {
            "sku_id": sku_id,
            "quantity": 1,
            "currency": "usd",
            "foreign_unit_price": "46.67",
            "fx_rate": "1431.9",
            "unit_paid_price": "66815.79",
        },
    )

    # 통화 코드는 대문자로 정규화한다.
    assert purchase["currency"] == "USD"
    assert purchase["fx_rate"] == "1431.900000"


def test_unknown_sku_returns_not_found(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/purchases",
        json={"sku_id": "00000000-0000-0000-0000-0000000000ff", "quantity": 1},
    )

    assert response.status_code == 404


def test_update_purchase_price(api_client: TestClient, prefix: str) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 1})

    response = api_client.patch(
        f"{prefix}/purchases/{purchase['id']}", json={"unit_paid_price": "45000"}
    )

    assert response.status_code == 200
    assert response.json()["unit_paid_price"] == "45000.00"


def test_delete_purchase_also_removes_bottles(api_client: TestClient, prefix: str) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 2})

    assert api_client.delete(f"{prefix}/purchases/{purchase['id']}").status_code == 204

    metrics = api_client.get(f"{prefix}/products/{product['id']}/metrics").json()
    assert metrics["purchased_count"] == 0
    assert metrics["in_stock_count"] == 0


# --- 구매 건 분할 -------------------------------------------------------------


def test_split_divides_purchase_and_reassigns_bottles(api_client: TestClient, prefix: str) -> None:
    """원본의 병 레코드를 재배치한다. 병을 새로 만들면 시음 기록이 끊긴다."""
    product, sku_id = _product_with_sku(api_client, prefix)
    mart = _vendor(api_client, prefix, "가상마트")
    shop = _vendor(api_client, prefix, "가상보틀샵", "bottle_shop")
    purchase = _post(
        api_client,
        f"{prefix}/purchases",
        {
            "sku_id": sku_id,
            "quantity": 3,
            "unit_list_price": "100000",
            "unit_paid_price": "90000",
        },
    )
    original_bottles = {
        bottle["id"]
        for bottle in api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()
    }

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={
            "parts": [
                {"quantity": 2, "vendor_id": mart["id"], "unit_paid_price": "85000"},
                {"quantity": 1, "vendor_id": shop["id"], "unit_paid_price": "100000"},
            ]
        },
    )

    assert response.status_code == 200, response.text
    parts = response.json()
    assert [part["quantity"] for part in parts] == [2, 1]
    assert {part["vendor_name"] for part in parts} == {"가상마트", "가상보틀샵"}
    assert {part["unit_paid_price"] for part in parts} == {"85000.00", "100000.00"}
    # 지정하지 않은 필드는 원본을 물려받는다.
    assert all(part["unit_list_price"] == "100000.00" for part in parts)

    moved_bottles: set[str] = set()
    for part in parts:
        bottles = api_client.get(f"{prefix}/purchases/{part['id']}/bottles").json()
        assert len(bottles) == part["quantity"]
        assert [bottle["label_no"] for bottle in bottles] == list(range(1, part["quantity"] + 1))
        moved_bottles.update(bottle["id"] for bottle in bottles)

    # 같은 병 레코드가 이동했을 뿐 새로 만들어지지 않았다.
    assert moved_bottles == original_bottles

    # 원본은 사라지고 제품 수준 병수는 그대로다.
    remaining = api_client.get(f"{prefix}/purchases", params={"product_id": product["id"]}).json()
    assert {item["id"] for item in remaining} == {part["id"] for part in parts}
    metrics = api_client.get(f"{prefix}/products/{product['id']}/metrics").json()
    assert metrics["purchased_count"] == 3
    assert metrics["in_stock_count"] == 3


def test_split_quantity_mismatch_is_rejected(api_client: TestClient, prefix: str) -> None:
    """조각 합계가 다르면 병 레코드와 구매 병수가 어긋난다."""
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 3})

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={"parts": [{"quantity": 1}, {"quantity": 1}]},
    )

    assert response.status_code == 422
    body = response.json()
    assert "병수 합계" in body["detail"]


def test_split_requires_at_least_two_parts(api_client: TestClient, prefix: str) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 2})

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split", json={"parts": [{"quantity": 2}]}
    )

    assert response.status_code == 422


def test_split_of_purchase_without_bottles_creates_them(
    api_client: TestClient, prefix: str
) -> None:
    """임포트가 병을 만들지 않았을 수도 있다. 부족분만 새로 만든다."""
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": sku_id, "quantity": 2, "create_bottles": False},
    )

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={"parts": [{"quantity": 1}, {"quantity": 1}]},
    )

    assert response.status_code == 200, response.text
    for part in response.json():
        bottles = api_client.get(f"{prefix}/purchases/{part['id']}/bottles").json()
        assert len(bottles) == 1
