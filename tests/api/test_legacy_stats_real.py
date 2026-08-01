"""통계 대시보드가 실제 레거시 시트를 재현하는지 검증 (opt-in).

실제 개인 기록은 커밋하지 않으므로 기본적으로 건너뛴다. `tests/api/test_legacy_import_real.py`
와 같은 방식으로 실행한다.

    SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet

Task 11 의 임포트 검증이 "적재된 원자료가 엑셀 합계행과 같은가"를 봤다면, 이 테스트는
"그 위에서 계산한 통계가 엑셀 대조 기준값과 같은가"를 본다
(`docs/legacy-schema.md` §5·§4.4).
"""

import os
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.requires_legacy_sheet

#: `docs/legacy-schema.md` §5 검증 기준값
EXPECTED_PURCHASED = 1078
EXPECTED_CONSUMED = 819
EXPECTED_IN_STOCK = 259
EXPECTED_UNOPENED = 225
EXPECTED_OPENED = 34
EXPECTED_VOLUME_ML = 704970
EXPECTED_LIST_TOTAL = Decimal(42401108)
EXPECTED_PAID_TOTAL = Decimal(36495454)
EXPECTED_AVG_LIST_PRICE = Decimal(39333)
EXPECTED_AVG_PAID_PRICE = Decimal(33855)
EXPECTED_AVG_PRICE_PER_100ML = Decimal(6015)
EXPECTED_AVG_RATING = Decimal("3.4")
EXPECTED_VENDORS = 82

#: `docs/legacy-schema.md` §4.4 주종 롤업 병수
EXPECTED_CATEGORY_BOTTLES = {
    "와인": 170,
    "사케": 12,
    "전통주": 120,
    "맥주": 642,
    "양주": 134,
}

#: 엑셀 셀 서식이 원 단위 미만을 절삭해 표시하므로 소액 차이를 허용한다.
AMOUNT_TOLERANCE = Decimal(20)
#: 평균값은 반올림 경로가 여러 번 겹쳐 legacy-schema.md 의 원 단위 값과 소수점 차이가 날 수 있다.
AVERAGE_TOLERANCE = Decimal(2)
RATING_TOLERANCE = Decimal("0.1")


def _sheet_path() -> Path:
    raw = os.environ.get("SOOLJANG_LEGACY_SHEET")
    if not raw:
        pytest.skip("SOOLJANG_LEGACY_SHEET 가 지정되지 않았습니다")
    path = Path(raw)
    if not path.exists():
        pytest.skip(f"레거시 시트를 찾을 수 없습니다: {path}")
    return path


@pytest.fixture
def committed(api_client: TestClient, prefix: str) -> Any:
    with _sheet_path().open("rb") as handle:
        response = api_client.post(
            f"{prefix}/imports/legacy:commit",
            files={"file": (_sheet_path().name, handle, "text/csv")},
        )
    assert response.status_code == 201, response.text
    return response.json()


def test_summary_reproduces_sheet_totals(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    summary = api_client.get(f"{prefix}/stats/summary").json()

    assert summary["purchased_count"] == EXPECTED_PURCHASED
    assert summary["consumed_count"] == EXPECTED_CONSUMED
    assert summary["in_stock_count"] == EXPECTED_IN_STOCK
    assert summary["unopened_count"] == EXPECTED_UNOPENED
    assert summary["opened_count"] == EXPECTED_OPENED
    assert summary["total_volume_ml"] == EXPECTED_VOLUME_ML
    assert abs(Decimal(summary["list_total"]) - EXPECTED_LIST_TOTAL) <= AMOUNT_TOLERANCE
    assert abs(Decimal(summary["paid_total"]) - EXPECTED_PAID_TOTAL) <= AMOUNT_TOLERANCE
    assert abs(Decimal(summary["avg_list_price"]) - EXPECTED_AVG_LIST_PRICE) <= AVERAGE_TOLERANCE
    assert abs(Decimal(summary["avg_paid_price"]) - EXPECTED_AVG_PAID_PRICE) <= AVERAGE_TOLERANCE
    assert (
        abs(Decimal(summary["avg_price_per_100ml"]) - EXPECTED_AVG_PRICE_PER_100ML)
        <= AVERAGE_TOLERANCE
    )
    assert abs(Decimal(summary["avg_personal_rating"]) - EXPECTED_AVG_RATING) <= RATING_TOLERANCE
    assert summary["vendor_count"] <= EXPECTED_VENDORS


def test_category_rollup_reproduces_top_level_bottle_counts(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """주종 롤업 병수는 반올림이 끼어들지 않는 정수 합계라 정확히 일치해야 한다."""
    stats = api_client.get(f"{prefix}/stats/by-category").json()
    by_name = {stat["name"]: stat["bottle_count"] for stat in stats}

    for name, expected in EXPECTED_CATEGORY_BOTTLES.items():
        assert by_name.get(name) == expected, f"{name}: {by_name.get(name)} != {expected}"

    assert sum(EXPECTED_CATEGORY_BOTTLES.values()) == EXPECTED_PURCHASED


def test_rankings_price_per_100ml_top_matches_sheet_leader(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """100ml당 가격 1위는 실측 상위 목록의 1위(글렌고인 25y, ₩154,286/100ml)와 같아야 한다.

    100ml당 가격은 정가 기준일 때만 엑셀과 일치한다(`docs/legacy-schema.md` §4.2).
    """
    rankings = api_client.get(f"{prefix}/stats/rankings", params={"limit": 1}).json()
    top = rankings["by_price_per_100ml"][0]

    assert "글렌고인" in top["product_name"]
    assert abs(Decimal(top["value"]) - Decimal(154286)) <= AVERAGE_TOLERANCE
