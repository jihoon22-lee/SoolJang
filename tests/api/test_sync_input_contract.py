"""오프라인 입력이 온라인 스키마/도메인과 같은 숫자 경계를 갖는다."""

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from sooljang.api.schemas.product import ProductCreate, PurchaseCreate, SkuCreate
from sooljang.api.schemas.tasting import TastingCreate
from sooljang.application.tastings import InvalidRatingError, validate_rating

CASES = json.loads((Path(__file__).parents[1] / "fixtures/sync_input_contract.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: f"{case['field']}={case['value']}")
def test_online_schema_matches_offline_numeric_contract(case: dict[str, Any]) -> None:
    field, value = case["field"], case["value"]
    try:
        if field in {"quantity", "price"}:
            PurchaseCreate.model_validate(
                {
                    "sku_id": uuid.uuid4(),
                    "quantity" if field == "quantity" else "unit_paid_price": value,
                }
            )
        elif field == "volume_ml":
            SkuCreate.model_validate({"volume_ml": value})
        elif field in {"abv", "personal_rating"}:
            ProductCreate.model_validate({"name": "합성 제품", field: value})
        else:
            tasting = TastingCreate.model_validate(
                {
                    "sku_id": uuid.uuid4(),
                    "tasted_on": "2026-01-01",
                    "rating" if field == "tasting_rating" else "poured_ml": value,
                }
            )
            validate_rating(tasting.rating)
        valid = True
    except ValidationError, InvalidRatingError:
        valid = False
    assert valid is case["valid"]
