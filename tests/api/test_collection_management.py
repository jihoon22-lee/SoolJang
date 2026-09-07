"""미리보기 재검증·재전송과 재고에 영향 없는 실사를 검증한다."""

import uuid
from typing import Any

from fastapi.testclient import TestClient


def post(client: TestClient, prefix: str, path: str, data: dict[str, Any]) -> dict[str, Any]:
    response = client.post(f"{prefix}{path}", json=data)
    assert response.status_code in {200, 201}, response.text
    return response.json()


def sample(client: TestClient, prefix: str) -> tuple[str, str, list[dict[str, Any]]]:
    product = post(client, prefix, "/products", {"name": "합성 술", "skus": [{"volume_ml": 700}]})
    vendor = post(client, prefix, "/vendors", {"name": "합성 매장"})
    purchase = post(
        client,
        prefix,
        "/purchases",
        {
            "sku_id": product["skus"][0]["id"],
            "vendor_id": vendor["id"],
            "quantity": 2,
            "unit_paid_price": "1000",
        },
    )
    bottles = client.get(f"{prefix}/collection/bottles").json()
    return vendor["id"], purchase["id"], bottles


def test_vendor_preview_preserves_totals_and_retry_is_idempotent(
    api_client: TestClient, prefix: str
) -> None:
    source, purchase_id, _ = sample(api_client, prefix)
    target = post(api_client, prefix, "/vendors", {"name": "합성 매장 본점"})["id"]
    preview = post(
        api_client,
        prefix,
        "/collection/cleanup/preview",
        {"kind": "vendor_merge", "ids": [source], "target_id": target},
    )
    assert preview["snapshot"]["known_paid_total"] == "2000.00"
    assert preview["snapshot"]["affected_count"] == 1
    path = f"/collection/cleanup/{preview['id']}/confirm"
    assert post(api_client, prefix, path, {})["confirmed"]
    assert post(api_client, prefix, path, {})["confirmed"]
    purchases = api_client.get(f"{prefix}/purchases").json()
    assert purchases[0]["id"] == purchase_id
    assert purchases[0]["vendor_id"] == target
    assert purchases[0]["paid_total"] == "2000.00"
    assert len(api_client.get(f"{prefix}/collection/cleanup/history").json()) == 1


def test_changed_purchase_invalidates_entire_preview(api_client: TestClient, prefix: str) -> None:
    source, purchase_id, _ = sample(api_client, prefix)
    target = post(api_client, prefix, "/vendors", {"name": "다른 매장"})["id"]
    preview = post(
        api_client,
        prefix,
        "/collection/cleanup/preview",
        {"kind": "vendor_merge", "ids": [source], "target_id": target},
    )
    response = api_client.patch(
        f"{prefix}/purchases/{purchase_id}", json={"unit_paid_price": "1200"}
    )
    assert response.status_code == 200, response.text
    assert (
        api_client.post(f"{prefix}/collection/cleanup/{preview['id']}/confirm").status_code == 409
    )
    assert api_client.get(f"{prefix}/purchases").json()[0]["vendor_id"] == source


def test_bulk_category_is_atomic_and_rejects_foreign_reference(
    api_client: TestClient, prefix: str
) -> None:
    sample(api_client, prefix)
    product_id = api_client.get(f"{prefix}/collection/bottles").json()[0]["product_id"]
    category = post(api_client, prefix, "/categories", {"name": "새 주종"})["id"]
    response = api_client.post(
        f"{prefix}/collection/cleanup/preview",
        json={
            "kind": "product_category",
            "ids": [product_id, str(uuid.uuid4())],
            "target_id": category,
        },
    )
    assert response.status_code == 404
    assert api_client.get(f"{prefix}/products/{product_id}").json()["category_id"] is None
    preview = post(
        api_client,
        prefix,
        "/collection/cleanup/preview",
        {"kind": "product_category", "ids": [product_id], "target_id": category},
    )
    post(api_client, prefix, f"/collection/cleanup/{preview['id']}/confirm", {})
    assert api_client.get(f"{prefix}/products/{product_id}").json()["category_id"] == category


def test_locations_keep_each_bottle_separate_and_delete_preserves_history(
    api_client: TestClient, prefix: str
) -> None:
    _, _, bottles = sample(api_client, prefix)
    location = post(
        api_client, prefix, "/collection/locations", {"name": "찬장 A", "kind": "cabinet"}
    )["id"]
    path = f"{prefix}/collection/bottles/{bottles[0]['id']}/location"
    assert api_client.put(path, json={"location_id": location}).status_code == 200
    assert api_client.put(path, json={"location_id": location}).status_code == 200
    rows = api_client.get(f"{prefix}/collection/bottles").json()
    assert [row["location_id"] for row in rows].count(location) == 1
    history_path = f"{prefix}/collection/bottles/{bottles[0]['id']}/movements"
    assert len(api_client.get(history_path).json()) == 1
    preview = post(
        api_client,
        prefix,
        "/collection/cleanup/preview",
        {"kind": "location_delete", "ids": [location]},
    )
    assert preview["snapshot"]["affected_count"] == 1
    post(api_client, prefix, f"/collection/cleanup/{preview['id']}/confirm", {})
    assert len(api_client.get(history_path).json()) == 2
    assert all(
        row["location_id"] is None for row in api_client.get(f"{prefix}/collection/bottles").json()
    )
    assert api_client.get(f"{prefix}/collection/locations").json()[0]["deleted"]


def test_stocktake_duplicate_missing_pause_and_unrecorded_never_change_stock(
    api_client: TestClient, prefix: str
) -> None:
    _, _, bottles = sample(api_client, prefix)
    initial = api_client.get(f"{prefix}/stats/summary").json()
    row = post(api_client, prefix, "/collection/stocktakes", {"name": "합성 실사"})
    scan_path = f"/collection/stocktakes/{row['id']}/scan"
    payload = {"bottle_code": bottles[0]["bottle_code"]}
    assert not post(api_client, prefix, scan_path, payload)["duplicate"]
    assert post(api_client, prefix, scan_path, payload)["duplicate"]
    assert (
        api_client.post(f"{prefix}{scan_path}", json={"bottle_code": "8801234567890"}).status_code
        == 422
    )
    assert (
        api_client.post(
            f"{prefix}{scan_path}", json={"bottle_code": f"sooljang:bottle:{uuid.uuid4()}"}
        ).status_code
        == 404
    )
    status_path = f"{prefix}/collection/stocktakes/{row['id']}"
    assert api_client.patch(status_path, json={"status": "paused"}).status_code == 200
    assert api_client.post(f"{prefix}{scan_path}", json=payload).status_code == 409
    assert api_client.patch(status_path, json={"status": "active"}).status_code == 200
    post(
        api_client,
        prefix,
        f"/collection/stocktakes/{row['id']}/found",
        {"note": "등록되지 않은 병 1개"},
    )
    completed = api_client.patch(status_path, json={"status": "completed"}).json()
    assert len(completed["missing"]) == 1
    assert completed["found_notes"] == ["등록되지 않은 병 1개"]
    assert api_client.get(f"{prefix}/stats/summary").json() == initial
    assert api_client.patch(status_path, json={"status": "active"}).status_code == 409


def test_quality_treats_blank_and_explicit_zero_prices_as_free(
    api_client: TestClient, prefix: str
) -> None:
    _, purchase_id, _ = sample(api_client, prefix)
    api_client.patch(f"{prefix}/purchases/{purchase_id}", json={"unit_paid_price": "0"})
    report = api_client.get(f"{prefix}/collection/quality").json()
    assert report["coverage"]["known_price_purchases"] == 1
    assert report["coverage"]["unknown_price_purchases"] == 0
    assert report["coverage"]["known_paid_total"] == "0.00"
    api_client.patch(f"{prefix}/purchases/{purchase_id}", json={"unit_paid_price": None})
    report = api_client.get(f"{prefix}/collection/quality").json()
    assert report["coverage"]["unknown_price_purchases"] == 0
    assert not any(item["reason"] == "price" for item in report["items"])


def test_blank_gifts_and_points_prices_are_zero_in_purchase_product_and_statistics(
    api_client: TestClient, prefix: str
) -> None:
    product = post(
        api_client,
        prefix,
        "/products",
        {
            "name": "선물과 포인트 구매",
            "vintage": 2021,
            "skus": [{"volume_ml": 750}],
        },
    )
    sku_id = product["skus"][0]["id"]
    gift = post(api_client, prefix, "/purchases", {"sku_id": sku_id, "quantity": 2})
    assert gift["unit_list_price"] == gift["unit_paid_price"] == "0.00"
    assert gift["list_total"] == gift["paid_total"] == "0.00"
    post(
        api_client,
        prefix,
        "/purchases",
        {
            "sku_id": sku_id,
            "quantity": 1,
            "unit_list_price": "90000",
            "unit_paid_price": "60000",
        },
    )
    result = api_client.get(f"{prefix}/products/{product['id']}").json()
    assert result["vintage"] == 2021
    assert result["metrics"]["purchased_count"] == 3
    assert result["metrics"]["avg_list_price"] == "30000.00"
    assert result["metrics"]["avg_paid_price"] == "20000.00"
    summary = api_client.get(f"{prefix}/stats/summary").json()
    assert summary["avg_list_price"] == "30000.00"
    assert summary["avg_paid_price"] == "20000.00"
    report = api_client.get(f"{prefix}/collection/quality").json()
    assert report["coverage"]["unknown_price_purchases"] == 0
    assert not any(item["reason"] == "price" for item in report["items"])
