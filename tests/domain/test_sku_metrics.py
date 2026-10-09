"""공통 합성 정답으로 SKU별 원가와 제품 합계를 검증한다."""

from dataclasses import replace
from typing import Any

import pytest

from sooljang.domain.metrics import BottleRecord, PurchaseLot, compute_product_metrics
from tests.metrics_fixture import (
    assert_metrics,
    domain_inputs,
    domain_metrics_fields,
    product_cases,
)


@pytest.mark.parametrize("case", product_cases(), ids=lambda case: case["name"])
def test_product_and_sku_metrics_match_shared_case(case: dict[str, Any]) -> None:
    lots, bottles = domain_inputs(case)
    assert_metrics(
        domain_metrics_fields(compute_product_metrics(lots, bottles)), case["expected"]["metrics"]
    )
    for expected in case["expected"]["sku_summaries"]:
        sku_lots = [lot for lot in lots if lot.sku_id == expected["sku_id"]]
        purchases = {lot.purchase_id for lot in sku_lots}
        sku_bottles = [bottle for bottle in bottles if bottle.purchase_id in purchases]
        actual = compute_product_metrics(sku_lots, sku_bottles)
        assert_metrics(domain_metrics_fields(actual), expected["metrics"])


def test_mixed_volumes_without_purchase_links_cannot_silently_share_cost() -> None:
    with pytest.raises(ValueError, match="구매·SKU 연결"):
        compute_product_metrics(
            [PurchaseLot(quantity=1, volume_ml=500), PurchaseLot(quantity=1, volume_ml=750)],
            [BottleRecord("unopened")],
        )


@pytest.mark.parametrize("missing", ["purchase", "sku", "bottle_purchase", "unknown_purchase"])
def test_partially_missing_links_are_rejected(missing: str) -> None:
    lots, bottles = domain_inputs(product_cases()[0])
    if missing == "purchase":
        lots[0] = replace(lots[0], purchase_id=None)
    elif missing == "sku":
        lots[0] = replace(lots[0], sku_id=None)
    else:
        bottles[0] = replace(
            bottles[0], purchase_id=None if missing == "bottle_purchase" else "unknown"
        )
    with pytest.raises(ValueError):
        compute_product_metrics(lots, bottles)


def test_duplicate_purchase_ids_cannot_double_the_price_denominator() -> None:
    lots, bottles = domain_inputs(product_cases()[0])
    with pytest.raises(ValueError, match="중복"):
        compute_product_metrics([*lots, lots[0]], bottles)
