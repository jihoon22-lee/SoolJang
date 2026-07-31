"""실제 레거시 시트 적재 검증 (opt-in).

실제 개인 기록은 커밋하지 않으므로 기본적으로 건너뛴다. 파일 경로를 환경 변수로 지정하면
실행되며, `docs/legacy-schema.md` §5 의 검증 기준값과 대조한다.

    SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet

파서 단계(Task 6)에서 이미 파싱 정확성을 확인했다. 이 테스트는 **적재 후에도 같은 값이
나오는지** 를 본다. 파싱이 맞아도 적재에서 병수를 잘못 배분하거나 중복을 만들면 지표가
어긋난다.
"""

import os
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.requires_legacy_sheet

#: `docs/legacy-schema.md` §5 검증 기준값
EXPECTED_RECORD_COUNT = 429
EXPECTED_PURCHASED = 1078
EXPECTED_CONSUMED = 819
EXPECTED_IN_STOCK = 259
EXPECTED_UNOPENED = 225
EXPECTED_OPENED = 34
EXPECTED_LIST_TOTAL = Decimal(42401108)
EXPECTED_PAID_TOTAL = Decimal(36495454)
EXPECTED_VOLUME_ML = 704970
EXPECTED_VENDORS = 82

#: 엑셀 셀 서식이 원 단위 미만을 절삭해 표시하므로 소액 차이를 허용한다.
AMOUNT_TOLERANCE = Decimal(20)


def _sheet_path() -> Path:
    raw = os.environ.get("SOOLJANG_LEGACY_SHEET")
    if not raw:
        pytest.skip("SOOLJANG_LEGACY_SHEET 가 지정되지 않았습니다")
    path = Path(raw)
    if not path.exists():
        pytest.skip(f"레거시 시트를 찾을 수 없습니다: {path}")
    return path


def _upload(client: TestClient, prefix: str, action: str) -> Any:
    with _sheet_path().open("rb") as handle:
        return client.post(
            f"{prefix}/imports/legacy:{action}",
            files={"file": (_sheet_path().name, handle, "text/csv")},
        )


@pytest.fixture
def analysis(api_client: TestClient, prefix: str) -> Any:
    response = _upload(api_client, prefix, "analyze")
    assert response.status_code == 200, response.text
    return response.json()


def test_analysis_record_count_matches(analysis: Any) -> None:
    assert analysis["block"]["record_count"] == EXPECTED_RECORD_COUNT


def test_analysis_excludes_statistics_blocks(analysis: Any) -> None:
    block = analysis["block"]
    assert block["skipped_blank_lines"] == [326]
    assert block["total_row_lines"] == [432]
    assert block["excluded_line_count"] == 100


def test_analysis_totals_match_sheet(analysis: Any) -> None:
    totals = analysis["totals"]
    assert totals["source_rows"] == EXPECTED_RECORD_COUNT
    assert totals["bottles"] == EXPECTED_PURCHASED
    assert totals["volume_ml"] == EXPECTED_VOLUME_ML
    assert abs(Decimal(totals["list_amount"]) - EXPECTED_LIST_TOTAL) <= AMOUNT_TOLERANCE
    assert abs(Decimal(totals["paid_amount"]) - EXPECTED_PAID_TOTAL) <= AMOUNT_TOLERANCE
    assert totals["vendors"] <= EXPECTED_VENDORS


def test_analysis_reports_rows_needing_manual_split(analysis: Any) -> None:
    """구매처가 여러 곳인 28행 중 분할하지 못한 것을 사용자에게 알려야 한다."""
    review = analysis["review"]
    split = len(review["split_vendor_rows"])
    unsplit = len(review["unsplit_vendor_rows"])

    assert split + unsplit > 0
    assert split + unsplit <= 28


# --- 실제 적재 ---------------------------------------------------------------


@pytest.fixture
def committed(api_client: TestClient, prefix: str) -> Any:
    response = _upload(api_client, prefix, "commit")
    assert response.status_code == 201, response.text
    return response.json()


def test_commit_has_no_failed_rows(committed: Any) -> None:
    assert committed["failed_rows"] == [], f"실패 행: {committed['failed_rows'][:5]}"


def test_commit_creates_expected_bottle_count(committed: Any) -> None:
    assert committed["bottles_created"] == EXPECTED_PURCHASED


def test_commit_creates_all_products(committed: Any) -> None:
    """행 수와 제품 수는 다르다. 같은 이름·빈티지·도수는 한 제품으로 합쳐진다.

    합쳐진 행도 구매 건은 각각 만들어지므로 병수 총합은 보존된다.
    """
    total = committed["products_created"] + committed["products_reused"]
    assert total == EXPECTED_RECORD_COUNT
    # 실측: 429행 중 24행이 중복 판정으로 병합되어 405개 제품이 만들어진다.
    assert committed["products_created"] < EXPECTED_RECORD_COUNT
    assert committed["products_reused"] > 0


def test_committed_metrics_reproduce_sheet_totals(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """적재 후 파생 지표 합계가 엑셀 합계행과 일치해야 한다."""
    totals = {
        "purchased": 0,
        "consumed": 0,
        "in_stock": 0,
        "unopened": 0,
        "opened": 0,
    }
    paid = Decimal(0)
    listed = Decimal(0)
    volume = 0

    cursor: str | None = None
    seen = 0
    while True:
        params: dict[str, Any] = {"limit": 200}
        if cursor:
            params["cursor"] = cursor
        page = api_client.get(f"{prefix}/products", params=params).json()
        for item in page["items"]:
            metrics = item["metrics"]
            totals["purchased"] += metrics["purchased_count"]
            totals["consumed"] += metrics["consumed_count"]
            totals["in_stock"] += metrics["in_stock_count"]
            totals["unopened"] += metrics["unopened_count"]
            totals["opened"] += metrics["opened_count"]
            if metrics["list_total"]:
                listed += Decimal(metrics["list_total"])
            if metrics["paid_total"]:
                paid += Decimal(metrics["paid_total"])
            volume += metrics["total_volume_ml"]
            seen += 1
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert totals["purchased"] == EXPECTED_PURCHASED
    assert totals["consumed"] == EXPECTED_CONSUMED
    assert totals["in_stock"] == EXPECTED_IN_STOCK
    assert totals["unopened"] == EXPECTED_UNOPENED
    assert totals["opened"] == EXPECTED_OPENED
    assert abs(listed - EXPECTED_LIST_TOTAL) <= AMOUNT_TOLERANCE
    assert abs(paid - EXPECTED_PAID_TOTAL) <= AMOUNT_TOLERANCE
    assert volume == EXPECTED_VOLUME_ML
    # 커서 페이지네이션으로 전부 순회했는지 확인한다.
    assert seen > 0


def test_committed_vendors_match_measured_count(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    vendors = api_client.get(f"{prefix}/vendors").json()

    # 분할한 구매처 이름이 힌트를 떼고 정규화되므로 82곳 이하다.
    assert 0 < len(vendors) <= EXPECTED_VENDORS


def test_rerun_on_real_sheet_is_idempotent(api_client: TestClient, prefix: str) -> None:
    """실제 429행을 두 번 넣어도 중복이 생기지 않아야 한다."""
    first = _upload(api_client, prefix, "commit").json()
    second = _upload(api_client, prefix, "commit").json()

    assert first["products_created"] + first["products_reused"] == EXPECTED_RECORD_COUNT
    assert second["products_created"] == 0
    assert second["bottles_created"] == 0
    assert second["purchases_skipped"] > 0
