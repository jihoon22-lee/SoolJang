"""SKU 집계의 공통 합성 입력. 기대값은 JSON에 명시하며 구현에서 생성하지 않는다."""

import datetime
import json
import uuid
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.domain.metrics import BottleRecord, ProductMetrics, PurchaseLot
from sooljang.infrastructure.database.models import Bottle, BottleStatus, Product, Purchase, Sku


def product_cases() -> list[dict[str, Any]]:
    path = Path(__file__).parent / "fixtures" / "metrics_cases.json"
    return json.loads(path.read_text())["product_metrics_cases"]


def _date(value: str | None) -> datetime.date | None:
    return datetime.date.fromisoformat(value) if value else None


def domain_inputs(case: dict[str, Any]) -> tuple[list[PurchaseLot], list[BottleRecord]]:
    volumes = {row["sku_id"]: row["volume_ml"] for row in case["skus"]}
    lots = [
        PurchaseLot(
            purchase_id=row["purchase_id"],
            sku_id=row["sku_id"],
            quantity=row["quantity"],
            volume_ml=volumes[row["sku_id"]],
            unit_list_price=Decimal(row["unit_list_price"])
            if row["unit_list_price"] is not None
            else None,
            unit_paid_price=Decimal(row["unit_paid_price"])
            if row["unit_paid_price"] is not None
            else None,
        )
        for row in case["lots"]
    ]
    bottles = [
        BottleRecord(
            purchase_id=row["purchase_id"],
            status=row["status"],
            opened_on=_date(row.get("opened_on")),
            finished_on=_date(row.get("finished_on")),
        )
        for row in case["bottles"]
    ]
    return lots, bottles


def domain_metrics_fields(metrics: ProductMetrics) -> dict[str, Any]:
    return {
        **asdict(metrics.prices),
        "purchased_count": metrics.prices.purchased_count,
        "consumed_count": metrics.bottles.finished,
        "in_stock_count": metrics.bottles.in_stock,
        "unopened_count": metrics.bottles.unopened,
        "opened_count": metrics.bottles.open,
        "gifted_count": metrics.bottles.gifted,
        "sold_count": metrics.bottles.sold,
        "inventory_value_at_cost": metrics.inventory_value_at_cost,
    }


def assert_metrics(actual: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    for key, value in expected.items():
        if isinstance(value, str):
            assert actual[key] is not None, key
            assert Decimal(str(actual[key])) == Decimal(value), key
        else:
            assert actual[key] == value, key


def fixture_id(case: dict[str, Any], user_id: uuid.UUID, kind: str, alias: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"metrics:{user_id}:{case['name']}:{kind}:{alias}")


async def seed_product_case(
    session: AsyncSession, user_id: uuid.UUID, case: dict[str, Any]
) -> uuid.UUID:
    product_id = fixture_id(case, user_id, "product", "product")
    session.add(
        Product(
            id=product_id,
            user_id=user_id,
            name=case["name"],
            normalized_name=case["name"],
        )
    )
    await session.flush()
    for row in case["skus"]:
        session.add(
            Sku(
                id=fixture_id(case, user_id, "sku", row["sku_id"]),
                user_id=user_id,
                product_id=product_id,
                volume_ml=row["volume_ml"],
            )
        )
    await session.flush()
    for row in case["lots"]:
        session.add(
            Purchase(
                id=fixture_id(case, user_id, "purchase", row["purchase_id"]),
                user_id=user_id,
                sku_id=fixture_id(case, user_id, "sku", row["sku_id"]),
                quantity=row["quantity"],
                unit_list_price=row["unit_list_price"],
                unit_paid_price=row["unit_paid_price"],
            )
        )
    await session.flush()
    labels: dict[str, int] = defaultdict(int)
    for row in case["bottles"]:
        labels[row["purchase_id"]] += 1
        session.add(
            Bottle(
                id=fixture_id(case, user_id, "bottle", row["bottle_id"]),
                user_id=user_id,
                purchase_id=fixture_id(case, user_id, "purchase", row["purchase_id"]),
                label_no=labels[row["purchase_id"]],
                status=BottleStatus(row["status"]),
                remaining_ml=row["remaining_ml"],
                opened_on=_date(row.get("opened_on")),
                finished_on=_date(row.get("finished_on")),
            )
        )
    await session.flush()
    return product_id
