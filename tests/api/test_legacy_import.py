"""레거시 임포트 API 테스트.

멱등성이 핵심이다. 사용자가 실수로 두 번 누르는 일은 반드시 생기고, 그때 429행이 858행이
되면 복구가 어렵다.
"""

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parents[1] / "infrastructure/legacy/testdata/sample_sheet.csv"


def _upload(client: TestClient, prefix: str, action: str) -> Any:
    with FIXTURE.open("rb") as handle:
        response = client.post(
            f"{prefix}/imports/legacy:{action}",
            files={"file": ("sample_sheet.csv", handle, "text/csv")},
        )
    return response


# --- dry-run ----------------------------------------------------------------


def test_analyze_reports_block_separation(api_client: TestClient, prefix: str) -> None:
    """통계 블록이 제외되었는지 사용자가 확인할 수 있어야 한다."""
    response = _upload(api_client, prefix, "analyze")

    assert response.status_code == 200, response.text
    block = response.json()["block"]
    assert block["record_count"] == 7
    assert block["skipped_blank_lines"], "데이터 중간의 빈 행을 통과 기록으로 남겨야 한다"
    assert block["total_row_lines"], "본 테이블 합계행을 배제 기록으로 남겨야 한다"
    assert block["excluded_line_count"] > 0


def test_analyze_reports_totals(api_client: TestClient, prefix: str) -> None:
    response = _upload(api_client, prefix, "analyze")

    totals = response.json()["totals"]
    assert totals["source_rows"] == 7
    assert totals["bottles"] == 14
    assert totals["volume_ml"] == 9300
    # Decimal 은 소수 자리를 유지해 직렬화된다. 픽스처 합계행과 같은 값이다.
    assert totals["list_amount"] == "545980.00"
    assert totals["paid_amount"] == "443980.00"


def test_analyze_reports_items_needing_review(api_client: TestClient, prefix: str) -> None:
    response = _upload(api_client, prefix, "analyze")

    review = response.json()["review"]
    assert review["unsplit_vendor_rows"], "분할하지 못한 구매처 행을 알려야 한다"
    assert review["warning_summary"]


def test_analyze_includes_normalized_sample(api_client: TestClient, prefix: str) -> None:
    response = _upload(api_client, prefix, "analyze")

    sample = response.json()["sample"]
    assert len(sample) <= 5
    first = sample[0]
    # 빈티지가 이름에서 분리되고 품종 오타가 정규화되어야 한다.
    assert first["vintage"] == 2019
    assert first["category_path"] == ["와인", "레드와인"]
    assert "Cabernet Sauvignon" in first["varieties"]


def test_analyze_does_not_write_to_database(api_client: TestClient, prefix: str) -> None:
    """dry-run 은 DB 를 건드리지 않는다."""
    _upload(api_client, prefix, "analyze")

    products = api_client.get(f"{prefix}/products").json()
    categories = api_client.get(f"{prefix}/categories").json()

    assert products["items"] == []
    assert categories["items"] == []


def test_empty_file_is_rejected(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/imports/legacy:analyze",
        files={"file": ("empty.csv", b"", "text/csv")},
    )

    assert response.status_code == 422
    assert "빈 파일" in response.json()["detail"]


def test_unrecognized_sheet_is_rejected(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/imports/legacy:analyze",
        files={"file": ("other.csv", "컬럼1,컬럼2\n1,2\n".encode("cp949"), "text/csv")},
    )

    assert response.status_code == 422
    assert "헤더" in response.json()["detail"]


# --- 실제 적재 ---------------------------------------------------------------


@pytest.fixture
def committed(api_client: TestClient, prefix: str) -> Any:
    response = _upload(api_client, prefix, "commit")
    assert response.status_code == 201, response.text
    return response.json()


def test_commit_creates_products_and_bottles(committed: Any) -> None:
    assert committed["products_created"] == 7
    assert committed["skus_created"] == 7
    assert committed["bottles_created"] == 14
    assert committed["failed_rows"] == []


def test_commit_creates_categories_and_vendors(committed: Any) -> None:
    assert committed["categories_created"] > 0
    assert committed["vendors_created"] > 0


def test_committed_products_appear_in_list(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    listed = api_client.get(f"{prefix}/products", params={"limit": 50}).json()

    assert len(listed["items"]) == 7
    names = {item["name"] for item in listed["items"]}
    assert "가상 와이너리 카베르네" in names


def test_committed_metrics_reproduce_legacy_values(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """레거시 실측 케이스가 적재 후에도 재현되어야 한다.

    750ml 1병 23,980원 → 100ml당 3,197.33원
    """
    listed = api_client.get(f"{prefix}/products", params={"limit": 50}).json()
    cabernet = next(item for item in listed["items"] if item["name"] == "가상 와이너리 카베르네")

    metrics = cabernet["metrics"]
    assert metrics["purchased_count"] == 1
    assert metrics["avg_list_price"] == "23980.00"
    assert metrics["price_per_100ml"] == "3197.33"


def test_committed_bottle_states_match_source(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """소진·미개봉·개봉 병수가 원본과 같아야 한다."""
    listed = api_client.get(f"{prefix}/products", params={"limit": 50}).json()
    totals = {"consumed": 0, "unopened": 0, "opened": 0}
    for item in listed["items"]:
        totals["consumed"] += item["metrics"]["consumed_count"]
        totals["unopened"] += item["metrics"]["unopened_count"]
        totals["opened"] += item["metrics"]["opened_count"]

    # 픽스처 합계행: 구매 14 / 소비 8 / 재고 6 (미개봉 4 + 개봉 2)
    assert totals == {"consumed": 8, "unopened": 4, "opened": 2}


def test_unknown_category_is_preserved_under_unclassified(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """사전에 없는 주종도 버리지 않는다. 사용자가 나중에 옮길 수 있어야 한다."""
    tree = api_client.get(f"{prefix}/categories").json()
    paths = {tuple(item["path"]) for item in tree["items"]}

    assert ("미분류", "가상신주종") in paths


def test_unsplit_vendor_row_keeps_original_text(
    api_client: TestClient, prefix: str, committed: Any
) -> None:
    """분할하지 못한 구매처 원문이 보존되어야 나중에 쪼갤 수 있다."""
    purchases = api_client.get(f"{prefix}/purchases").json()
    notes = [purchase["import_note"] or "" for purchase in purchases]

    assert any("원문:" in note for note in notes)


def test_foreign_currency_is_recorded(api_client: TestClient, prefix: str, committed: Any) -> None:
    purchases = api_client.get(f"{prefix}/purchases").json()
    foreign = [purchase for purchase in purchases if purchase["currency"] != "KRW"]

    assert foreign
    assert foreign[0]["currency"] == "USD"
    assert foreign[0]["fx_rate"] is not None


# --- 멱등성 -----------------------------------------------------------------


def test_rerun_does_not_duplicate(api_client: TestClient, prefix: str) -> None:
    """같은 파일을 두 번 넣어도 중복이 생기지 않아야 한다."""
    first = _upload(api_client, prefix, "commit").json()
    second = _upload(api_client, prefix, "commit").json()

    assert first["products_created"] == 7
    assert second["products_created"] == 0
    assert second["products_reused"] == 7
    assert second["purchases_created"] == 0
    assert second["purchases_skipped"] > 0
    assert second["bottles_created"] == 0

    listed = api_client.get(f"{prefix}/products", params={"limit": 50}).json()
    assert len(listed["items"]) == 7


def test_rerun_keeps_bottle_counts_stable(api_client: TestClient, prefix: str) -> None:
    _upload(api_client, prefix, "commit")
    before = _total_bottles(api_client, prefix)

    _upload(api_client, prefix, "commit")
    after = _total_bottles(api_client, prefix)

    assert before == after == 14


def _total_bottles(client: TestClient, prefix: str) -> int:
    listed = client.get(f"{prefix}/products", params={"limit": 50}).json()
    return sum(item["metrics"]["purchased_count"] for item in listed["items"])


def test_import_after_seed_reuses_existing_categories(api_client: TestClient, prefix: str) -> None:
    """시드된 주종이 이미 있으면 다시 만들지 않는다."""
    api_client.post(f"{prefix}/categories:reset-seed")
    before = len(api_client.get(f"{prefix}/categories").json()["items"])

    result = _upload(api_client, prefix, "commit").json()
    after = len(api_client.get(f"{prefix}/categories").json()["items"])

    # 미분류 하위의 새 주종만 추가된다.
    assert result["categories_created"] < before
    assert after > before
