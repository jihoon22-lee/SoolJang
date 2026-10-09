"""실제 PostgreSQL 집계를 공통 JSON의 독립 정답과 대조한다."""

import uuid
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.products import metrics_from_row, sku_summaries_for_products
from sooljang.infrastructure.database.metrics_sql import single_product_metrics_query
from sooljang.infrastructure.database.models import Product
from tests.metrics_fixture import assert_metrics, fixture_id, product_cases, seed_product_case

pytestmark = pytest.mark.requires_db


@pytest.mark.parametrize("case", product_cases(), ids=lambda case: case["name"])
async def test_sql_product_and_sku_metrics_match_shared_case(
    session: AsyncSession, user_id: uuid.UUID, case: dict[str, Any]
) -> None:
    product_id = await seed_product_case(session, user_id, case)
    row = (await session.execute(single_product_metrics_query(user_id, product_id))).first()
    # SKU가 없는 제품은 기존 API 기본 응답과 같이 집계 행 자체가 없을 수 있다.
    actual = (
        metrics_from_row(row)
        if row is not None
        else {
            "purchased_count": 0,
            "in_stock_count": 0,
            "avg_paid_price": None,
            "inventory_value_at_cost": None,
        }
    )
    assert_metrics(actual, case["expected"]["metrics"])
    product = await session.scalar(select(Product).where(Product.id == product_id))
    assert product is not None
    summaries = (
        await sku_summaries_for_products(session, user_id=user_id, products=[product])
    ).get(product_id, [])
    expected = case["expected"]["sku_summaries"]
    assert [item["sku_id"] for item in summaries] == [
        fixture_id(case, user_id, "sku", item["sku_id"]) for item in expected
    ]
    for item, expected_item in zip(summaries, expected, strict=True):
        assert item["volume_ml"] == expected_item["volume_ml"]
        assert_metrics(item["metrics"], expected_item["metrics"])
