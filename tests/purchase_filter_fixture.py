"""제품·구매·병 원본과 조건별 M 정답을 공유 JSON에서 읽는다."""

import datetime
import json
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Product,
    Purchase,
    Sku,
    Vendor,
)


def filter_datasets() -> list[dict[str, Any]]:
    return json.loads(
        (Path(__file__).parent / "fixtures" / "purchase_filter_cases.json").read_text()
    )["datasets"]


def filter_fixture_id(dataset: dict[str, Any], kind: str, alias: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"purchase-filter:{dataset['name']}:{kind}:{alias}")


async def seed_filter_dataset(
    session: AsyncSession, user_id: uuid.UUID, dataset: dict[str, Any]
) -> None:
    for row in dataset["vendors"]:
        session.add(
            Vendor(
                id=filter_fixture_id(dataset, "vendor", row["vendor_id"]),
                user_id=user_id,
                name=row["name"],
            )
        )
    for row in dataset["products"]:
        session.add(
            Product(
                id=uuid.UUID(row["product_id"]),
                user_id=user_id,
                name=row["name"],
                normalized_name=row["name"],
            )
        )
    await session.flush()
    for product in dataset["products"]:
        for row in product["skus"]:
            session.add(
                Sku(
                    id=filter_fixture_id(dataset, "sku", row["sku_id"]),
                    user_id=user_id,
                    product_id=uuid.UUID(product["product_id"]),
                    volume_ml=row["volume_ml"],
                )
            )
    await session.flush()
    for product in dataset["products"]:
        for row in product["lots"]:
            session.add(
                Purchase(
                    id=filter_fixture_id(dataset, "purchase", row["purchase_id"]),
                    user_id=user_id,
                    sku_id=filter_fixture_id(dataset, "sku", row["sku_id"]),
                    vendor_id=filter_fixture_id(dataset, "vendor", row["vendor_id"])
                    if row["vendor_id"] is not None
                    else None,
                    purchased_on=datetime.date.fromisoformat(row["purchased_on"])
                    if row["purchased_on"] is not None
                    else None,
                    quantity=row["quantity"],
                    unit_list_price=row["unit_list_price"],
                    unit_paid_price=row["unit_paid_price"],
                )
            )
    await session.flush()
    labels: dict[str, int] = defaultdict(int)
    for product in dataset["products"]:
        for row in product["bottles"]:
            labels[row["purchase_id"]] += 1
            session.add(
                Bottle(
                    id=filter_fixture_id(dataset, "bottle", row["bottle_id"]),
                    user_id=user_id,
                    purchase_id=filter_fixture_id(dataset, "purchase", row["purchase_id"]),
                    label_no=labels[row["purchase_id"]],
                    status=BottleStatus(row["status"]),
                    remaining_ml=row["remaining_ml"],
                )
            )
    await session.flush()
