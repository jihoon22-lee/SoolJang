"""Python/SQL과 Dexie가 공유하는 상태별 주종 보유 정답."""

import json
from pathlib import Path

from fastapi.testclient import TestClient


def test_category_inventory_matches_shared_fixture(api_client: TestClient, prefix: str) -> None:
    data = json.loads(
        (Path(__file__).parents[1] / "fixtures/category_inventory_cases.json").read_text()
    )
    root = api_client.post(f"{prefix}/categories", json={"name": "상위"}).json()
    child = api_client.post(
        f"{prefix}/categories", json={"name": "하위", "parent_id": root["id"]}
    ).json()
    products = {
        key: api_client.post(
            f"{prefix}/products",
            json={"name": str(key), "category_id": child["id"] if key else None},
        ).json()
        for key in ["child", None]
    }
    for lot in data["lots"]:
        product = products[lot["category"]]
        sku = api_client.post(
            f"{prefix}/products/{product['id']}/skus", json={"volume_ml": lot["volume"]}
        ).json()
        purchase = api_client.post(
            f"{prefix}/purchases",
            json={"sku_id": sku["id"], "quantity": len(lot["states"]), "unit_paid_price": "10000"},
        ).json()
        bottles = [
            b
            for b in api_client.get(f"{prefix}/bottles").json()
            if b["purchase_id"] == purchase["id"]
        ]
        for bottle, status in zip(bottles, lot["states"], strict=True):
            if status == "unopened":
                continue
            action = {"open": "open", "finished": "finish", "gifted": "gift", "sold": "sell"}[
                status
            ]
            response = api_client.post(f"{prefix}/bottles/{bottle['id']}:{action}", json={})
            assert response.status_code == 200, response.text
    stats = api_client.get(f"{prefix}/stats/by-category").json()
    for stat in stats:
        expected = data["expected"]["root" if stat["category_id"] else "uncategorized"]
        assert {key: stat.get(key) for key in expected} == expected
    detailed = api_client.get(
        f"{prefix}/stats/by-category", params={"include_children": True}
    ).json()
    child_stat = next(stat for stat in detailed if stat["category_id"] == child["id"])
    assert {key: child_stat[key] for key in data["expected"]["root"]} == data["expected"]["root"]
    assert child_stat["parent_category_id"] == root["id"]
