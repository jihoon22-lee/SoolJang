"""통계 API 테스트."""

from typing import Any

from fastapi.testclient import TestClient


def _seed_product(
    client: TestClient,
    prefix: str,
    *,
    name: str,
    rating: str | None = None,
    volume_ml: int = 700,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": name, "skus": [{"volume_ml": volume_ml}]}
    if rating is not None:
        payload["personal_rating"] = rating
    response = client.post(f"{prefix}/products", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _add_purchase(
    client: TestClient,
    prefix: str,
    *,
    sku_id: str,
    quantity: int = 1,
    unit_list_price: str | None = None,
    unit_paid_price: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"sku_id": sku_id, "quantity": quantity}
    if unit_list_price is not None:
        payload["unit_list_price"] = unit_list_price
    if unit_paid_price is not None:
        payload["unit_paid_price"] = unit_paid_price
    response = client.post(f"{prefix}/purchases", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_stats_endpoints_require_auth(anon_client: TestClient, prefix: str) -> None:
    for path in ("/stats/rankings", "/stats/by-category", "/stats/summary"):
        response = anon_client.get(f"{prefix}{path}")
        assert response.status_code == 401, path


def test_empty_collection_returns_empty_shapes(api_client: TestClient, prefix: str) -> None:
    rankings = api_client.get(f"{prefix}/stats/rankings").json()
    assert rankings == {
        "by_bottle_price": [],
        "by_total_spend": [],
        "by_price_per_100ml": [],
        "by_personal_rating": [],
    }
    assert api_client.get(f"{prefix}/stats/by-category").json() == []

    summary = api_client.get(f"{prefix}/stats/summary").json()
    assert summary["purchased_count"] == 0
    assert summary["list_total"] is None


def test_rankings_and_summary_reflect_seeded_purchases(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="랭킹 테스트 술", rating="5.0")
    sku_id = product["skus"][0]["id"]
    _add_purchase(
        api_client,
        prefix,
        sku_id=sku_id,
        quantity=2,
        unit_list_price="30000",
        unit_paid_price="27000",
    )

    rankings = api_client.get(f"{prefix}/stats/rankings").json()
    assert rankings["by_bottle_price"][0]["product_name"] == "랭킹 테스트 술"
    assert rankings["by_bottle_price"][0]["value"] == "27000.00"
    assert rankings["by_personal_rating"][0]["value"] == "5.0"

    summary = api_client.get(f"{prefix}/stats/summary").json()
    assert summary["purchased_count"] == 2
    assert summary["list_total"] == "60000.00"
    assert summary["paid_total"] == "54000.00"
    assert summary["vendor_count"] == 0

    by_category = api_client.get(f"{prefix}/stats/by-category").json()
    assert by_category[0]["name"] == "미분류"
    assert by_category[0]["bottle_count"] == 2


def test_rankings_limit_query_param(api_client: TestClient, prefix: str) -> None:
    for i in range(3):
        product = _seed_product(api_client, prefix, name=f"제품{i}")
        _add_purchase(
            api_client,
            prefix,
            sku_id=product["skus"][0]["id"],
            unit_list_price=str(10000 + i),
            unit_paid_price=str(10000 + i),
        )

    rankings = api_client.get(f"{prefix}/stats/rankings", params={"limit": 1}).json()
    assert len(rankings["by_bottle_price"]) == 1
