"""목록·상세·통계가 같은 SKU 집계를 보여주고 변경 후 재계산하는지 검증한다."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event

from sooljang.infrastructure.database.session import get_session_factory
from tests.metrics_fixture import fixture_id, product_cases, seed_product_case


def _seed(client: TestClient, user_id: uuid.UUID, case: dict[str, Any]) -> uuid.UUID:
    async def create() -> uuid.UUID:
        async with get_session_factory().begin() as session:
            return await seed_product_case(session, user_id, case)

    assert client.portal is not None
    return client.portal.call(create)


@pytest.mark.parametrize("case", product_cases(), ids=lambda case: case["name"])
def test_list_detail_and_stats_use_shared_sku_values(
    api_client: TestClient, prefix: str, api_user_id: uuid.UUID, case: dict[str, Any]
) -> None:
    product_id = _seed(api_client, api_user_id, case)
    response = api_client.get(f"{prefix}/products/{product_id}")
    assert response.status_code == 200, response.text
    detail = response.json()
    listing = api_client.get(f"{prefix}/products").json()["items"]
    assert listing == [detail]
    expected = case["expected"]
    for key, value in expected["metrics"].items():
        assert detail["metrics"][key] == value, key
    assert len(detail["sku_summaries"]) == len(expected["sku_summaries"])
    for actual, wanted in zip(detail["sku_summaries"], expected["sku_summaries"], strict=True):
        assert actual["sku_id"] == str(fixture_id(case, api_user_id, "sku", wanted["sku_id"]))
        assert actual["volume_ml"] == wanted["volume_ml"]
        for key, value in wanted["metrics"].items():
            assert actual["metrics"][key] == value, key
    summary = api_client.get(f"{prefix}/stats/summary").json()
    assert summary["inventory_value_at_cost"] == expected["metrics"]["inventory_value_at_cost"]


def test_collection_cost_sums_confirmed_product_costs(
    api_client: TestClient, prefix: str, api_user_id: uuid.UUID
) -> None:
    cases = product_cases()
    _seed(api_client, api_user_id, cases[0])
    _seed(api_client, api_user_id, next(case for case in cases if case["name"].startswith("g05")))
    summary = api_client.get(f"{prefix}/stats/summary").json()
    assert summary["inventory_value_at_cost"] == "76666.67"
    assert summary["in_stock_count"] == 3


def test_purchase_price_change_and_delete_recompute_only_its_sku(
    api_client: TestClient, prefix: str, api_user_id: uuid.UUID
) -> None:
    case = product_cases()[0]
    product_id = _seed(api_client, api_user_id, case)
    purchase_id = fixture_id(case, api_user_id, "purchase", "purchase-2")
    updated = api_client.patch(
        f"{prefix}/purchases/{purchase_id}", json={"unit_paid_price": "40000"}
    )
    assert updated.status_code == 200, updated.text
    product = api_client.get(f"{prefix}/products/{product_id}").json()
    assert product["metrics"]["avg_paid_price"] == "25000.00"
    assert product["metrics"]["inventory_value_at_cost"] == "40000.00"
    assert product["sku_summaries"][1]["metrics"]["avg_paid_price"] == "10000.00"
    resized = api_client.patch(f"{prefix}/purchases/{purchase_id}", json={"quantity": 2})
    assert resized.status_code == 200, resized.text
    product = api_client.get(f"{prefix}/products/{product_id}").json()
    assert product["metrics"]["inventory_value_at_cost"] == "80000.00"
    assert product["metrics"]["in_stock_count"] == 2
    assert product["metrics"]["avg_paid_price"] == "30000.00"
    assert api_client.delete(f"{prefix}/purchases/{purchase_id}").status_code == 204
    product = api_client.get(f"{prefix}/products/{product_id}").json()
    assert product["metrics"]["inventory_value_at_cost"] == "0.00"
    assert product["sku_summaries"][1]["metrics"]["avg_paid_price"] is None
    assert product["sku_summaries"][1]["metrics"]["purchased_count"] == 0


def test_product_creation_and_edit_include_unpurchased_sku_summary(
    api_client: TestClient, prefix: str
) -> None:
    created = api_client.post(
        f"{prefix}/products", json={"name": "미구매 규격", "skus": [{"volume_ml": 750}]}
    )
    assert created.status_code == 201, created.text
    product = created.json()
    summaries = product["sku_summaries"]
    assert summaries[0]["sku_id"] == product["skus"][0]["id"]
    assert summaries[0]["metrics"]["inventory_value_at_cost"] is None
    edited = api_client.patch(f"{prefix}/products/{product['id']}", json={"name": "수정한 제품"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["sku_summaries"] == summaries


def test_product_list_query_count_does_not_grow_per_sku_or_product(
    api_client: TestClient, prefix: str
) -> None:
    def add_product(number: int) -> None:
        response = api_client.post(
            f"{prefix}/products",
            json={"name": f"집계 성능 {number}", "skus": [{"volume_ml": 500}, {"volume_ml": 750}]},
        )
        assert response.status_code == 201

    def count_selects(action: Callable[[], Any]) -> int:
        statements: list[str] = []

        def observe(
            _conn: Any, _cursor: Any, statement: str, _parameters: Any, _context: Any, _many: bool
        ) -> None:
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(Engine, "before_cursor_execute", observe)
        try:
            response = action()
            assert response.status_code == 200, response.text
        finally:
            event.remove(Engine, "before_cursor_execute", observe)
        return len(statements)

    add_product(0)
    one = count_selects(lambda: api_client.get(f"{prefix}/products"))
    for number in range(1, 8):
        add_product(number)
    many = count_selects(lambda: api_client.get(f"{prefix}/products"))
    assert many == one
