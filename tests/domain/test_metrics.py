"""파생 지표 순수 함수 테스트 (`docs/architecture.md` §3)."""

import datetime
import json
from decimal import Decimal
from pathlib import Path

import pytest

from sooljang.domain.metrics import (
    BottleRecord,
    BottleState,
    BottleTally,
    PurchaseLot,
    compute_price_metrics,
    compute_product_metrics,
    consumption_rate_per_month,
    krw_from_foreign,
    quantize_money,
    tally_bottles,
    value_for_money,
)

#: Python(순수 함수)·SQL·TS(`web/src/domain/metrics.ts`) 3-way parity 공유 기준값.
_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "metrics_cases.json"


def _lot(qty: int, volume: int, list_price: str | None, paid_price: str | None) -> PurchaseLot:
    return PurchaseLot(
        quantity=qty,
        volume_ml=volume,
        unit_list_price=Decimal(list_price) if list_price is not None else None,
        unit_paid_price=Decimal(paid_price) if paid_price is not None else None,
    )


# --- 입력 검증 ---------------------------------------------------------------


@pytest.mark.parametrize(("qty", "volume"), [(0, 700), (-1, 700), (1, 0), (1, -100)])
def test_purchase_lot_rejects_non_positive_values(qty: int, volume: int) -> None:
    with pytest.raises(ValueError, match="양수"):
        PurchaseLot(quantity=qty, volume_ml=volume)


# --- 단일 구매 건 -------------------------------------------------------------


def test_single_lot_metrics_match_legacy_formula() -> None:
    """레거시 실측 케이스: 750ml 1병, 총액 23,980원 → 100ml당 3,197원."""
    metrics = compute_price_metrics([_lot(1, 750, "23980", "23980")])

    assert metrics.purchased_count == 1
    assert metrics.list_total == Decimal(23980)
    assert metrics.avg_list_price == Decimal("23980.00")
    # 23980 / 7.5 = 3197.333... → 3197.33
    assert metrics.price_per_100ml == Decimal("3197.33")
    assert metrics.discount_rate == Decimal("0.0000")
    assert metrics.total_volume_ml == 750


def test_multiple_bottles_divide_total_by_quantity() -> None:
    """레거시 실측 케이스: 500ml 2병, 총액 32,000원 → 평단가 16,000원, 100ml당 3,200원."""
    metrics = compute_price_metrics([_lot(2, 500, "16000", "16000")])

    assert metrics.avg_list_price == Decimal("16000.00")
    assert metrics.price_per_100ml == Decimal("3200.00")


def test_price_per_100ml_uses_list_price_not_paid_price() -> None:
    """레거시 실측 케이스: 평단가 219,900 / 750ml → 29,320원 (정가 기준).

    실구매가 179,900 기준으로 계산하면 23,987원이 되어 레거시와 어긋난다.
    """
    metrics = compute_price_metrics([_lot(1, 750, "219900", "179900")])

    assert metrics.price_per_100ml == Decimal("29320.00")
    assert metrics.price_per_100ml_paid == Decimal("23986.67")


# --- 다중 구매 건 -------------------------------------------------------------


def test_multiple_lots_produce_weighted_average() -> None:
    """같은 술을 다른 가격에 여러 번 산 경우. 단순 평균이 아니라 병수 가중 평균이다."""
    metrics = compute_price_metrics(
        [_lot(2, 700, "100000", "90000"), _lot(1, 700, "130000", "128000")]
    )

    # (100000*2 + 130000*1) / 3 = 110000
    assert metrics.avg_list_price == Decimal("110000.00")
    # (90000*2 + 128000*1) / 3 = 102666.67
    assert metrics.avg_paid_price == Decimal("102666.67")
    assert metrics.purchased_count == 3


def test_mixed_volumes_use_weighted_per_100ml() -> None:
    """700ml 와 1000ml 가 섞이면 단순 평균으로는 틀린다."""
    metrics = compute_price_metrics(
        [_lot(1, 700, "70000", "70000"), _lot(1, 1000, "80000", "80000")]
    )

    # (70000 + 80000) * 100 / (700 + 1000) = 8823.529... → 8823.53
    assert metrics.price_per_100ml == Decimal("8823.53")
    assert metrics.total_volume_ml == 1700


# --- 가격 결측 (선물) ---------------------------------------------------------


def test_gift_lot_is_excluded_from_money_but_counted_in_bottles() -> None:
    """레거시에 정가 결측 33건이 있다. 병수는 세고 금액은 빼야 한다."""
    metrics = compute_price_metrics([_lot(2, 900, None, None), _lot(1, 900, "30000", "30000")])

    assert metrics.purchased_count == 3
    assert metrics.priced_quantity == 1
    assert metrics.list_total == Decimal(30000)
    # 무가격 구매 건이 평단가를 끌어내리지 않아야 한다.
    assert metrics.avg_list_price == Decimal("30000.00")


def test_all_gift_lots_yield_none_not_zero() -> None:
    """0 을 반환하면 '전부 무료' 와 '가격 정보 없음' 을 구분할 수 없다."""
    metrics = compute_price_metrics([_lot(2, 900, None, None)])

    assert metrics.purchased_count == 2
    assert metrics.list_total is None
    assert metrics.avg_list_price is None
    assert metrics.price_per_100ml is None
    assert metrics.discount_rate is None
    assert metrics.has_prices is False


def test_list_price_only_lot_has_no_paid_metrics() -> None:
    metrics = compute_price_metrics([_lot(1, 700, "50000", None)])

    assert metrics.avg_list_price == Decimal("50000.00")
    assert metrics.avg_paid_price is None
    assert metrics.price_per_100ml_paid is None
    # 한쪽만 있으면 할인율을 계산할 수 없다.
    assert metrics.discount_rate is None


def test_discount_rate_only_uses_lots_with_both_prices() -> None:
    """한쪽만 있는 구매 건을 섞으면 분모와 분자의 모집단이 달라져 왜곡된다."""
    metrics = compute_price_metrics(
        [
            _lot(1, 700, "100000", "80000"),  # 할인율 20%
            _lot(1, 700, "100000", None),  # 제외되어야 한다
        ]
    )

    assert metrics.discount_rate == Decimal("0.2000")


def test_empty_lots_produce_zero_counts_and_none_prices() -> None:
    metrics = compute_price_metrics([])

    assert metrics.purchased_count == 0
    assert metrics.avg_list_price is None
    assert metrics.total_volume_ml == 0


# --- 병수 집계 ---------------------------------------------------------------


def test_tally_counts_each_status() -> None:
    tally = tally_bottles(
        [
            BottleRecord(BottleState.UNOPENED),
            BottleRecord(BottleState.UNOPENED),
            BottleRecord(BottleState.OPEN),
            BottleRecord(BottleState.FINISHED),
            BottleRecord(BottleState.GIFTED),
            BottleRecord(BottleState.SOLD),
        ]
    )

    assert tally == BottleTally(unopened=2, open=1, finished=1, gifted=1, sold=1)
    assert tally.in_stock == 3
    assert tally.disposed == 2
    assert tally.total == 6


# --- 공유 골든값 (Python·SQL·TS 3-way parity) ----------------------------------


def _load_fixture() -> dict:
    return json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "case", _load_fixture()["price_metrics_cases"], ids=lambda case: case["name"]
)
def test_price_metrics_matches_shared_fixture(case: dict) -> None:
    """`web/src/domain/metrics.test.ts` 와 같은 픽스처를 읽는다 — 갈라지면 여기서 잡힌다."""
    lots = [
        _lot(
            row["quantity"],
            row["volume_ml"],
            row["unit_list_price"],
            row["unit_paid_price"],
        )
        for row in case["lots"]
    ]
    metrics = compute_price_metrics(lots)

    for key, expected in case["expected"].items():
        actual = getattr(metrics, key)
        if expected is None:
            assert actual is None, f"{case['name']}.{key}: {actual} 는 None 이어야 함"
        else:
            assert actual == Decimal(expected), f"{case['name']}.{key}: {actual} != {expected}"


def test_bottle_tally_matches_shared_fixture() -> None:
    case = _load_fixture()["bottle_tally_case"]
    tally = tally_bottles(BottleRecord(status) for status in case["statuses"])
    expected = case["expected"]

    assert tally.unopened == expected["unopened"]
    assert tally.open == expected["open"]
    assert tally.finished == expected["finished"]
    assert tally.gifted == expected["gifted"]
    assert tally.sold == expected["sold"]
    assert tally.in_stock == expected["in_stock"]
    assert tally.disposed == expected["disposed"]
    assert tally.total == expected["total"]


def test_gifted_and_sold_are_not_stock() -> None:
    """증여·판매한 병은 재고가 아니다. 레거시는 이를 구분하지 못했다."""
    tally = tally_bottles([BottleRecord(BottleState.GIFTED), BottleRecord(BottleState.SOLD)])

    assert tally.in_stock == 0
    assert tally.disposed == 2


def test_unknown_status_is_ignored() -> None:
    tally = tally_bottles([BottleRecord("알 수 없음"), BottleRecord(BottleState.OPEN)])

    assert tally.total == 1
    assert tally.open == 1


def test_bottle_in_stock_property() -> None:
    assert BottleRecord(BottleState.UNOPENED).in_stock is True
    assert BottleRecord(BottleState.OPEN).in_stock is True
    assert BottleRecord(BottleState.FINISHED).in_stock is False


# --- 개봉 후 소진 기간 --------------------------------------------------------


def test_days_to_finish_requires_both_dates() -> None:
    opened = datetime.date(2026, 5, 1)
    finished = datetime.date(2026, 5, 21)

    assert BottleRecord(BottleState.FINISHED, opened, finished).days_to_finish == 20
    assert BottleRecord(BottleState.FINISHED, opened, None).days_to_finish is None
    assert BottleRecord(BottleState.FINISHED, None, finished).days_to_finish is None


def test_average_days_to_finish_ignores_incomplete_records() -> None:
    metrics = compute_product_metrics(
        [_lot(3, 700, "30000", "30000")],
        [
            BottleRecord(
                BottleState.FINISHED, datetime.date(2026, 1, 1), datetime.date(2026, 1, 11)
            ),
            BottleRecord(
                BottleState.FINISHED, datetime.date(2026, 2, 1), datetime.date(2026, 2, 21)
            ),
            BottleRecord(BottleState.UNOPENED),
        ],
    )

    # (10 + 20) / 2 = 15
    assert metrics.average_days_to_finish == Decimal("15.0000")


# --- 제품 수준 종합 -----------------------------------------------------------


def test_product_metrics_combine_prices_and_bottles() -> None:
    metrics = compute_product_metrics(
        [_lot(2, 700, "100000", "90000"), _lot(1, 700, "130000", "128000")],
        [
            BottleRecord(BottleState.UNOPENED),
            BottleRecord(BottleState.OPEN),
            BottleRecord(BottleState.FINISHED),
        ],
    )

    assert metrics.in_stock_count == 2
    assert metrics.consumed_count == 1
    # 실평단가 102666.67 × 재고 2병
    assert metrics.inventory_value_at_cost == Decimal("205333.34")
    assert metrics.consistency_warnings == ()


def test_bottle_count_mismatch_produces_warning_not_exception() -> None:
    """레거시 데이터가 완벽하지 않을 수 있다. 지표를 아예 못 보는 것보다 경고가 낫다."""
    metrics = compute_product_metrics(
        [_lot(3, 700, "30000", "30000")], [BottleRecord(BottleState.UNOPENED)]
    )

    assert metrics.consistency_warnings
    assert "구매 병수" in metrics.consistency_warnings[0]
    assert metrics.prices.purchased_count == 3


def test_inventory_value_is_none_without_paid_prices() -> None:
    metrics = compute_product_metrics(
        [_lot(1, 700, None, None)], [BottleRecord(BottleState.UNOPENED)]
    )

    assert metrics.inventory_value_at_cost is None


def test_fully_consumed_product_has_zero_inventory_value() -> None:
    metrics = compute_product_metrics(
        [_lot(1, 700, "50000", "50000")], [BottleRecord(BottleState.FINISHED)]
    )

    assert metrics.in_stock_count == 0
    assert metrics.inventory_value_at_cost == Decimal("0.00")


# --- 보조 지표 ---------------------------------------------------------------


def test_value_for_money_is_higher_when_cheaper() -> None:
    cheap = value_for_money(Decimal("4.5"), Decimal("3000"))
    expensive = value_for_money(Decimal("4.5"), Decimal("30000"))

    assert cheap is not None and expensive is not None
    assert cheap > expensive


@pytest.mark.parametrize(
    ("rating", "price"),
    [(None, Decimal("3000")), (Decimal("4.5"), None), (Decimal("4.5"), Decimal(0))],
)
def test_value_for_money_undefined_cases(rating: Decimal | None, price: Decimal | None) -> None:
    assert value_for_money(rating, price) is None


def test_consumption_rate_converts_to_monthly() -> None:
    assert consumption_rate_per_month(6, 90) == Decimal("2.0000")
    assert consumption_rate_per_month(0, 30) == Decimal("0.0000")
    assert consumption_rate_per_month(3, 0) is None


def test_foreign_currency_uses_purchase_time_rate() -> None:
    """레거시 실측 케이스: $46.67 × 1431.6 = 66,812.772 → 66,812.77원."""
    assert krw_from_foreign(Decimal("46.67"), Decimal("1431.6")) == Decimal("66812.77")
    assert krw_from_foreign(None, Decimal("1431.6")) is None
    assert krw_from_foreign(Decimal("46.67"), None) is None


def test_quantize_money_rounds_half_up() -> None:
    assert quantize_money(Decimal("1.005")) == Decimal("1.01")
    assert quantize_money(Decimal("1.004")) == Decimal("1.00")
