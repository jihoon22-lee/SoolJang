"""임포트 계획 수립 테스트.

구매처 분할 규칙이 가장 까다롭다. 레거시 28행이 한 셀에 여러 구매처를 담고 있는데 형식이
통일되지 않아, 억지로 나누면 병수와 금액이 어긋난 채 적재된다.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from sooljang.application.import_plan import (
    build_plan,
    parse_vendor_shares,
    summarize_warnings,
)
from sooljang.infrastructure.legacy.records import parse_sheet

FIXTURE = Path(__file__).parents[1] / "infrastructure/legacy/testdata/sample_sheet.csv"


# --- 구매처 분할 -------------------------------------------------------------


def test_single_vendor_takes_all_bottles() -> None:
    shares = parse_vendor_shares(("가상마트",), 3)

    assert [(share.name, share.quantity) for share in shares] == [("가상마트", 3)]


def test_no_vendor_produces_no_shares() -> None:
    assert parse_vendor_shares((), 2) == []


def test_star_quantity_hint_is_used() -> None:
    """실측 형식: `스타보틀 인계 * 3`"""
    shares = parse_vendor_shares(("스타보틀 인계 * 3", "라빈리쿼 * 1"), 4)

    assert [(share.name, share.quantity) for share in shares] == [
        ("스타보틀 인계", 3),
        ("라빈리쿼", 1),
    ]


def test_trailing_number_hint_is_used() -> None:
    """실측 형식: `이마트 스마트오더 1 / 트레이더스 수원점 2`"""
    shares = parse_vendor_shares(("이마트 스마트오더 1", "트레이더스 수원점 2"), 3)

    assert [(share.name, share.quantity) for share in shares] == [
        ("이마트 스마트오더", 1),
        ("트레이더스 수원점", 2),
    ]


def test_parenthesized_number_is_price_not_quantity() -> None:
    """실측 형식: `레투와(9.1)` — 괄호 안은 만원 단위 가격 메모다.

    이를 병수로 오인하면 9병으로 적재된다.
    """
    shares = parse_vendor_shares(("레투와(9.1)", "스타보틀 인계(6.8)"), 2)

    # 병수 힌트가 없으므로 분할을 포기한다.
    assert shares == []


def test_split_is_abandoned_when_hints_do_not_sum() -> None:
    """힌트 합계가 구매 병수와 다르면 억지로 나누지 않는다."""
    shares = parse_vendor_shares(("가상마트 1", "가상샵 1"), 5)

    assert shares == []


def test_split_is_abandoned_without_any_hint() -> None:
    shares = parse_vendor_shares(("이마트 수원점", "와인픽스 동탄점"), 3)

    assert shares == []


# --- 계획 수립 ---------------------------------------------------------------


@pytest.fixture(scope="module")
def plan() -> object:
    return build_plan(parse_sheet(FIXTURE))


def test_plan_counts_match_fixture(plan) -> None:  # type: ignore[no-untyped-def]
    # 픽스처는 본 데이터 7행, 구매 14병이다.
    assert plan.source_row_count == 7
    assert plan.bottle_count == 14


def test_plan_amounts_match_fixture(plan) -> None:  # type: ignore[no-untyped-def]
    assert plan.total_list_amount == Decimal(545980)
    assert plan.total_paid_amount == Decimal(443980)


def test_plan_volume_matches_fixture(plan) -> None:  # type: ignore[no-untyped-def]
    assert plan.total_volume_ml == 9300


def test_plan_collects_categories_and_vendors(plan) -> None:  # type: ignore[no-untyped-def]
    assert ("와인", "레드와인") in plan.category_paths
    assert "가상마트 1호점" in plan.vendor_names


def test_plan_records_unsplit_vendor_rows(plan) -> None:  # type: ignore[no-untyped-def]
    """픽스처의 메를로 행은 구매처 2곳에 병수 힌트가 없어 분할되지 않는다."""
    assert plan.unsplit_vendor_rows


def test_unsplit_row_preserves_original_text() -> None:
    plan = build_plan(parse_sheet(FIXTURE))
    unsplit = [
        product
        for product in plan.products
        if len(product.purchases) == 1 and product.purchases[0].import_note
    ]

    assert unsplit
    assert "\n" in (unsplit[0].purchases[0].import_note or "")


def test_unsplit_row_warns_about_manual_split() -> None:
    plan = build_plan(parse_sheet(FIXTURE))
    warnings = [warning for product in plan.products for warning in product.warnings]

    assert any("구매 건 분할" in warning for warning in warnings)


def test_bottle_states_are_distributed_across_purchases() -> None:
    """분할된 구매 건에 상태별 병수를 배분하되 총합은 보존한다."""
    plan = build_plan(parse_sheet(FIXTURE))

    for product in plan.products:
        total = sum(
            purchase.unopened + purchase.opened + purchase.finished
            for purchase in product.purchases
        )
        assert total == product.total_quantity, f"{product.line_number}행 병 상태 합계 불일치"


def test_merge_groups_detect_duplicate_identity() -> None:
    """같은 이름·빈티지·도수는 한 제품이다."""
    from sooljang.infrastructure.legacy.blocks import MAIN_HEADER
    from sooljang.infrastructure.legacy.records import parse_rows

    def row(name: str) -> list[str]:
        cells = [""] * 20
        cells[0] = name
        cells[1] = "700ml"
        cells[2] = "40.0%"
        cells[3] = "싱글몰트 위스키"
        cells[10:15] = ["1", "0", "1", "1", "0"]
        return cells

    plan = build_plan(parse_rows([list(MAIN_HEADER), row("같은 술"), row("같은 술")]))

    assert plan.source_row_count == 2
    assert plan.product_count == 1
    assert len(plan.merge_groups) == 1


def test_warning_summary_groups_by_kind() -> None:
    plan = build_plan(parse_sheet(FIXTURE))

    summary = summarize_warnings(plan)

    assert summary
    # 같은 종류의 경고가 하나로 묶여야 429행에서도 읽을 수 있다.
    assert all(isinstance(count, int) for _, count in summary)


def _row(name: str, *, volume: str = "700ml", counts: list[str] | None = None) -> list[str]:
    cells = [""] * 20
    cells[0] = name
    cells[1] = volume
    cells[2] = "40.0%"
    cells[3] = "싱글몰트 위스키"
    cells[10:15] = counts or ["1", "0", "1", "1", "0"]
    return cells


def test_unsplit_row_bottles_match_purchased_count_when_states_disagree() -> None:
    """구매 2병인데 미개봉 2 + 개봉 1로 적힌 행도 병은 2개만 만든다(분할 경로와 같은 규칙)."""
    from sooljang.infrastructure.legacy.blocks import MAIN_HEADER
    from sooljang.infrastructure.legacy.records import parse_rows

    plan = build_plan(
        parse_rows([list(MAIN_HEADER), _row("상태 합계 불일치", counts=["2", "0", "2", "2", "1"])])
    )

    (purchase,) = plan.products[0].purchases
    assert purchase.quantity == 2
    assert purchase.unopened + purchase.opened + purchase.finished == 2


def test_blank_volume_row_with_purchases_is_flagged_in_preview() -> None:
    from sooljang.infrastructure.legacy.blocks import MAIN_HEADER
    from sooljang.infrastructure.legacy.records import parse_rows

    plan = build_plan(
        parse_rows([list(MAIN_HEADER), _row("용량 공란", volume=""), _row("정상 행")])
    )

    # 적재 때 반드시 실패할 행은 "적재될 내용" 합계·표본에 넣지 않고 따로 알린다.
    assert [product.name for product in plan.products] == ["정상 행"]
    assert plan.purchase_count == 1
    assert [line for line, _ in plan.failing_rows] == [2]
    assert "용량이 비어 있어" in plan.failing_rows[0][1]
