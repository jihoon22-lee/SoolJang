"""M의 조건 결합·가격·커서가 독립 합성 정답과 일치해야 한다."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.infrastructure.database.session import get_session_factory
from tests.purchase_filter_fixture import (
    filter_datasets,
    filter_fixture_id,
    seed_filter_dataset,
)


@pytest.mark.parametrize(
    ("dataset", "query"),
    [(dataset, query) for dataset in filter_datasets() for query in dataset["queries"]],
    ids=[query["name"] for dataset in filter_datasets() for query in dataset["queries"]],
)
def test_purchase_filter_prices_and_cursor_match_shared_expectations(
    api_client: TestClient,
    prefix: str,
    api_user_id: uuid.UUID,
    dataset: dict[str, Any],
    query: dict[str, Any],
) -> None:
    async def seed() -> None:
        async with get_session_factory().begin() as session:
            await seed_filter_dataset(session, api_user_id, dataset)

    assert api_client.portal is not None
    api_client.portal.call(seed)
    filters = dict(query["filters"])
    if "vendor_id" in filters:
        filters["vendor_id"] = str(filter_fixture_id(dataset, "vendor", filters["vendor_id"]))
    params = {**filters, "limit": 1}
    rows = []
    seen_cursors = set()
    while True:
        response = api_client.get(f"{prefix}/products", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        rows.extend(page["items"])
        if page["next_cursor"] is None:
            break
        assert page["next_cursor"] not in seen_cursors
        seen_cursors.add(page["next_cursor"])
        params["cursor"] = page["next_cursor"]
    assert [row["id"] for row in rows] == query["expected_ids"]
    scoped = any(
        key in filters
        for key in ("volume_ml", "vendor_id", "purchased_on_min", "purchased_on_max", "in_stock")
    )
    for row in rows:
        assert (row["filtered_prices"] is not None) is scoped
        if scoped:
            assert len(row["filtered_prices"]) == 9
        else:
            assert row["filtered_stock_count"] is None
        prices = row["filtered_prices"] if scoped else row["metrics"]
        for key, value in query["expected_prices"].get(row["id"], {}).items():
            assert prices[key] == value, key
        if row["id"] in query["expected_filtered_stock"]:
            assert row["filtered_stock_count"] == query["expected_filtered_stock"][row["id"]]
        for key, value in query.get("expected_metrics", {}).get(row["id"], {}).items():
            assert row["metrics"][key] == value, key


def test_purchase_filter_rejects_reversed_dates_and_invalid_volume(
    api_client: TestClient, prefix: str
) -> None:
    for params in (
        {"purchased_on_min": "2026-12-31", "purchased_on_max": "2026-01-01"},
        {"volume_ml": 0},
        {"volume_ml": 100_001},
    ):
        assert api_client.get(f"{prefix}/products", params=params).status_code == 422
