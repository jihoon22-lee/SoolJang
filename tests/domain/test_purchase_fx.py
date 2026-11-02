"""외화 구매 규칙(D276). 웹 사전 검사와 같은 경계값 fixture 를 쓴다."""

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from sooljang.domain.purchase_fx import (
    ForeignPrice,
    ForeignPriceError,
    reconcile_foreign_price,
    reconcile_update,
)

FIXTURE = Path(__file__).parents[1] / "fixtures" / "purchase_fx_cases.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def _decimal(value: str | None) -> Decimal | None:
    return None if value is None else Decimal(value)


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_cases_match_web_precheck(case: dict[str, Any]) -> None:
    arguments = {
        "currency": case["currency"],
        "fx_rate": _decimal(case["fx_rate"]),
        "foreign_unit_price": _decimal(case["foreign_unit_price"]),
        "unit_paid_price": _decimal(case["unit_paid_price"]),
    }

    if case["problem"] is None:
        paid = reconcile_foreign_price(**arguments)
        assert paid == _decimal(case["paid"])
        if paid is not None:
            assert str(paid) == case["paid"]
    else:
        with pytest.raises(ForeignPriceError) as raised:
            reconcile_foreign_price(**arguments)
        assert raised.value.code == case["problem"]


_STORED = ForeignPrice(
    currency="USD",
    fx_rate=Decimal("1431.900000"),
    foreign_unit_price=Decimal("46.67"),
    unit_paid_price=Decimal("66827.00"),
)
_MISMATCHED = ForeignPrice(
    currency="USD",
    fx_rate=Decimal("1431.900000"),
    foreign_unit_price=Decimal("46.67"),
    unit_paid_price=Decimal("46.67"),
)


def test_update_without_foreign_price_fields_is_not_checked() -> None:
    updates = {"vendor_id": None, "unit_list_price": Decimal("70000")}

    assert reconcile_update(_MISMATCHED, updates) == updates


def test_update_resending_stored_values_keeps_an_old_mismatch_editable() -> None:
    """이미 어긋난 이전 기록도 같은 값을 다시 보내는 수정(구매처 등)은 막지 않는다."""
    updates = {"unit_paid_price": Decimal("46.67"), "fx_rate": Decimal("1431.9")}

    assert reconcile_update(_MISMATCHED, updates) == updates


def test_update_changing_paid_price_checks_merged_row() -> None:
    with pytest.raises(ForeignPriceError) as raised:
        reconcile_update(_STORED, {"unit_paid_price": Decimal("0")})

    assert raised.value.code == "paid_mismatch"


def test_update_changing_rate_checks_stored_paid_price() -> None:
    with pytest.raises(ForeignPriceError) as raised:
        reconcile_update(_STORED, {"fx_rate": Decimal("1500")})

    assert raised.value.code == "paid_mismatch"


def test_update_clearing_paid_price_fills_conversion() -> None:
    result = reconcile_update(_STORED, {"fx_rate": Decimal("1500"), "unit_paid_price": None})

    assert result == {"fx_rate": Decimal("1500"), "unit_paid_price": Decimal("70005.00")}


def test_update_switching_to_krw_must_clear_foreign_price() -> None:
    with pytest.raises(ForeignPriceError) as raised:
        reconcile_update(_STORED, {"currency": "KRW"})
    cleared = {"currency": "KRW", "fx_rate": None, "foreign_unit_price": None}

    assert raised.value.code == "currency_not_foreign"
    assert reconcile_update(_STORED, cleared) == cleared


def test_update_removing_rate_from_foreign_price_is_rejected() -> None:
    with pytest.raises(ForeignPriceError) as raised:
        reconcile_update(_STORED, {"fx_rate": None})

    assert raised.value.code == "fx_rate_required"
