"""엔드투엔드 통합 시나리오(Task 21).

각 기능은 이미 단위·API 테스트로 촘촘히 검증돼 있다. 이 테스트의 목적은 다르다 —
등록 → 검색·필터 → 구매 건 분할 → 병 개봉 → 시음 기록 → 통계 확인 → 바코드 조회 →
피벗·저장뷰 → 오프라인 동기화까지 **하나의 연속된 사용자 여정**으로 이어 붙였을 때도
각 단계가 이전 단계의 결과를 올바르게 이어받는지 확인한다. 개별 테스트는 서로 독립적인
픽스처를 쓰므로, 이런 종류의 "한 흐름 전체가 맞물려 돌아가는가"는 개별 테스트로는
잡히지 않는다.
"""

import uuid
from typing import Any

from fastapi.testclient import TestClient


def test_등록부터_동기화까지_한_여정(api_client: TestClient, prefix: str) -> None:
    client = api_client

    # 1) 주종·구매처 등록
    category = client.post(f"{prefix}/categories", json={"name": "위스키"})
    assert category.status_code == 201, category.text
    category_id = category.json()["id"]

    vendor_a = client.post(f"{prefix}/vendors", json={"name": "여정마트"})
    assert vendor_a.status_code == 201, vendor_a.text
    vendor_a_id = vendor_a.json()["id"]

    # 2) 제품 등록(바코드 포함) — 규격에 바코드를 심어 바코드 조회 단계에서 재사용한다.
    barcode = "8801234500099"
    product = client.post(
        f"{prefix}/products",
        json={
            "name": "여정 위스키 12년",
            "category_id": category_id,
            "abv": "43.0",
            "personal_rating": "4.5",
            "skus": [{"volume_ml": 700, "barcode": barcode}],
        },
    )
    assert product.status_code == 201, product.text
    product_id = product.json()["id"]
    sku_id = product.json()["skus"][0]["id"]

    # 3) 검색·필터 — 방금 만든 제품이 실제로 목록에서 찾아지는지
    search = client.get(f"{prefix}/products", params={"q": "여정"})
    assert search.status_code == 200, search.text
    assert any(item["id"] == product_id for item in search.json()["items"])

    filtered = client.get(
        f"{prefix}/products", params={"category_id": category_id, "abv_min": "40"}
    )
    assert any(item["id"] == product_id for item in filtered.json()["items"])

    # 4) 구매 건 등록(병 3개 자동 생성) → 구매처별로 분할
    purchase = client.post(
        f"{prefix}/purchases",
        json={
            "sku_id": sku_id,
            "quantity": 3,
            "vendor_id": vendor_a_id,
            "purchased_on": "2026-03-01",
            "unit_list_price": "100000",
            "unit_paid_price": "85000",
        },
    )
    assert purchase.status_code == 201, purchase.text
    purchase_id = purchase.json()["id"]

    vendor_b = client.post(f"{prefix}/vendors", json={"name": "여정몰"})
    vendor_b_id = vendor_b.json()["id"]

    split = client.post(
        f"{prefix}/purchases/{purchase_id}:split",
        json={"parts": [{"quantity": 1, "vendor_id": vendor_b_id}, {"quantity": 2}]},
    )
    assert split.status_code == 200, split.text
    assert len(split.json()) == 2

    purchases_for_sku = client.get(f"{prefix}/purchases", params={"sku_id": sku_id})
    assert purchases_for_sku.status_code == 200, purchases_for_sku.text
    assert len(purchases_for_sku.json()) == 2  # 분할 후 원본 구매 건 2개(1병 + 2병)

    all_bottles = client.get(f"{prefix}/bottles", params={})
    assert all_bottles.status_code == 200, all_bottles.text
    assert len(all_bottles.json()) >= 3

    # 5) 병 하나를 개봉하고 시음 기록
    bottle_id = all_bottles.json()[0]["id"]
    opened = client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
    assert opened.status_code == 200, opened.text

    tasting = client.post(
        f"{prefix}/tastings",
        json={
            "bottle_id": bottle_id,
            "tasted_on": "2026-03-05",
            "rating": "5.0",
            "note": "여정 테스트",
        },
    )
    assert tasting.status_code == 201, tasting.text

    # 6) 통계 확인 — 방금 만든 데이터가 랭킹·주종별 집계·합계에 반영됐는가
    rankings = client.get(f"{prefix}/stats/rankings").json()
    assert any(e["product_name"] == "여정 위스키 12년" for e in rankings["by_bottle_price"])

    by_category = client.get(f"{prefix}/stats/by-category").json()
    assert any(c["name"] == "위스키" and c["bottle_count"] >= 3 for c in by_category)

    summary = client.get(f"{prefix}/stats/summary").json()
    assert summary["purchased_count"] >= 3

    # 7) 바코드 조회 — 등록한 규격이 로컬 매칭으로 잡히는가
    barcode_lookup = client.get(f"{prefix}/barcodes/{barcode}")
    assert barcode_lookup.status_code == 200, barcode_lookup.text
    assert barcode_lookup.json()["source"] == "local"
    assert barcode_lookup.json()["local_match"]["product_id"] == product_id

    # 8) 커스텀 피벗 — 방금 만든 구매처별 데이터가 정확히 묶이는가
    pivot = client.post(
        f"{prefix}/stats/pivot",
        json={"row_dimension": "vendor", "metric": "bottle_count"},
    )
    assert pivot.status_code == 200, pivot.text
    vendor_labels = {cell["row_label"] for cell in pivot.json()}
    assert "여정마트" in vendor_labels
    assert "여정몰" in vendor_labels

    # 9) 저장된 뷰로 남기고 다시 불러온다
    saved = client.post(
        f"{prefix}/saved-views",
        json={
            "name": "여정 뷰",
            "definition": {"row_dimension": "vendor", "metric": "bottle_count"},
        },
    )
    assert saved.status_code == 201, saved.text
    listed = client.get(f"{prefix}/saved-views").json()
    assert any(v["name"] == "여정 뷰" for v in listed)

    # 10) 오프라인에서 같은 제품을 하나 더 산 것처럼 outbox 배치를 보내고, 델타 풀로
    #     확인한다 — 온라인 REST 로 만든 데이터와 오프라인 배치로 만든 데이터가
    #     같은 통계·피벗 파이프라인에 함께 잡혀야 한다.
    offline_purchase_id = uuid.uuid4()
    offline_bottle_id = uuid.uuid4()
    batch = client.post(
        f"{prefix}/sync/batch",
        json={
            "operations": [
                _sync_op(
                    entity="purchase",
                    op="create",
                    entity_id=offline_purchase_id,
                    fields={
                        "sku_id": sku_id,
                        "quantity": 1,
                        "vendor_id": vendor_a_id,
                        "purchased_on": "2026-03-10",
                        "unit_list_price": "100000",
                        "unit_paid_price": "80000",
                        "bottle_ids": [str(offline_bottle_id)],
                    },
                ),
            ]
        },
    )
    assert batch.status_code == 200, batch.text
    assert batch.json()["results"][0]["status"] == "applied"

    pulled = client.get(f"{prefix}/sync", params={}).json()
    assert any(p["id"] == str(offline_purchase_id) for p in pulled["changes"]["purchase"])

    summary_after_offline = client.get(f"{prefix}/stats/summary").json()
    assert summary_after_offline["purchased_count"] >= 4


def _sync_op(
    *, entity: str, op: str, entity_id: uuid.UUID, fields: dict[str, Any]
) -> dict[str, Any]:
    return {
        "idempotency_key": str(entity_id),
        "entity": entity,
        "op": op,
        "entity_id": str(entity_id),
        "action": None,
        "base_updated_at": None,
        "fields": fields,
    }
