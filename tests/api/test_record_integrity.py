"""기록 무결성 경계: 시음이 붙은 구매 삭제, 개봉 잔량 범위, 늦게 온 시음의 소진 병 날짜."""

import datetime
from typing import Any

from fastapi.testclient import TestClient


def _purchase_with_bottles(
    client: TestClient, prefix: str, *, quantity: int = 2, volume_ml: int = 700
) -> dict[str, Any]:
    product = client.post(
        f"{prefix}/products", json={"name": "무결성 위스키", "skus": [{"volume_ml": volume_ml}]}
    )
    assert product.status_code == 201, product.text
    sku_id = product.json()["skus"][0]["id"]
    purchase = client.post(f"{prefix}/purchases", json={"sku_id": sku_id, "quantity": quantity})
    assert purchase.status_code == 201, purchase.text
    bottles = client.get(f"{prefix}/purchases/{purchase.json()['id']}/bottles").json()
    return {
        "product_id": product.json()["id"],
        "sku_id": sku_id,
        "purchase_id": purchase.json()["id"],
        "bottle_ids": [bottle["id"] for bottle in bottles],
    }


def _expected_user(client: TestClient, prefix: str) -> str:
    return client.get(f"{prefix}/auth/me").json()["id"]


def test_purchase_with_tasted_bottle_cannot_be_deleted_and_keeps_bottles(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix)
    tasting = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": setup["bottle_ids"][0], "tasted_on": "2026-10-01", "poured_ml": 30},
    )
    assert tasting.status_code == 201, tasting.text

    response = api_client.delete(f"{prefix}/purchases/{setup['purchase_id']}")

    assert response.status_code == 409, response.text
    assert "시음 기록이 있는 병 1개" in response.json()["detail"]
    bottles = api_client.get(f"{prefix}/purchases/{setup['purchase_id']}/bottles").json()
    assert len(bottles) == 2
    record = api_client.get(f"{prefix}/tastings/{tasting.json()['id']}")
    assert record.status_code == 200
    assert record.json()["bottle"]["id"] == setup["bottle_ids"][0]


def test_offline_purchase_delete_with_tasted_bottle_fails_without_orphaning(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix, quantity=1)
    tasting = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": setup["bottle_ids"][0], "tasted_on": "2026-10-01"},
    )
    assert tasting.status_code == 201, tasting.text

    response = api_client.post(
        f"{prefix}/sync/batch",
        json={
            "expected_user_id": _expected_user(api_client, prefix),
            "operations": [
                {
                    "idempotency_key": "01990000-0000-7000-8000-00000000d001",
                    "entity": "purchase",
                    "entity_id": setup["purchase_id"],
                    "op": "delete",
                    "fields": {},
                }
            ],
        },
    )

    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["status"] == "failed"
    assert "시음 기록이 있는 병" in result["detail"]
    bottle = api_client.get(f"{prefix}/bottles/{setup['bottle_ids'][0]}")
    assert bottle.status_code == 200


def test_purchase_whose_tastings_were_deleted_can_still_be_deleted(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix, quantity=1)
    tasting = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": setup["bottle_ids"][0], "tasted_on": "2026-10-01"},
    ).json()
    removed = api_client.request(
        "DELETE",
        f"{prefix}/tastings/{tasting['id']}",
        json={
            "request_id": "01990000-0000-7000-8000-00000000d002",
            "expected_updated_at": tasting["updated_at"],
        },
    )
    assert removed.status_code == 200, removed.text

    assert api_client.delete(f"{prefix}/purchases/{setup['purchase_id']}").status_code == 204


def test_open_rejects_zero_or_more_than_volume_remaining(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix, quantity=1, volume_ml=700)
    bottle_id = setup["bottle_ids"][0]

    for remaining in (0, 701):
        response = api_client.post(
            f"{prefix}/bottles/{bottle_id}:open", json={"remaining_ml": remaining}
        )
        assert response.status_code in {409, 422}, response.text
        assert api_client.get(f"{prefix}/bottles/{bottle_id}").json()["status"] == "unopened"

    opened = api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={"remaining_ml": 700})
    assert opened.status_code == 200, opened.text
    assert opened.json()["remaining_ml"] == 700


def test_late_offline_tasting_keeps_finished_bottle_dates(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix, quantity=1, volume_ml=700)
    bottle_id = setup["bottle_ids"][0]
    assert (
        api_client.post(
            f"{prefix}/bottles/{bottle_id}:open", json={"opened_on": "2026-09-10"}
        ).status_code
        == 200
    )
    finished = api_client.post(
        f"{prefix}/bottles/{bottle_id}:finish", json={"finished_on": "2026-10-05"}
    )
    assert finished.status_code == 200, finished.text

    response = api_client.post(
        f"{prefix}/sync/batch",
        json={
            "expected_user_id": _expected_user(api_client, prefix),
            "operations": [
                {
                    "idempotency_key": "01990000-0000-7000-8000-00000000d003",
                    "entity": "tasting_session",
                    "entity_id": "01990000-0000-7000-8000-00000000d004",
                    "op": "action",
                    "action": "record_tasting",
                    "fields": {"bottle_id": bottle_id, "tasted_on": "2026-09-01", "poured_ml": 50},
                }
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["status"] == "applied", response.text
    bottle = api_client.get(f"{prefix}/bottles/{bottle_id}").json()
    assert bottle["status"] == "finished"
    assert bottle["opened_on"] == "2026-09-10"
    assert bottle["finished_on"] == "2026-10-05"
    assert bottle["remaining_ml"] == 0
    tastings = api_client.get(f"{prefix}/tastings", params={"bottle_id": bottle_id}).json()
    assert [item["tasted_on"] for item in tastings] == ["2026-09-01"]


def test_category_delete_cannot_reassign_products_to_itself(
    api_client: TestClient, prefix: str
) -> None:
    category = api_client.post(f"{prefix}/categories", json={"name": "자기 재배정 주종"}).json()
    product = api_client.post(
        f"{prefix}/products", json={"name": "주종 소속 술", "category_id": category["id"]}
    )
    assert product.status_code == 201, product.text

    response = api_client.delete(
        f"{prefix}/categories/{category['id']}",
        params={"strategy": "reassign", "target_id": category["id"]},
    )

    assert response.status_code in {409, 422}, response.text
    detail = api_client.get(f"{prefix}/products/{product.json()['id']}").json()
    assert detail["category_id"] == category["id"]
    assert "자기 재배정 주종" in api_client.get(f"{prefix}/categories").text


def test_recently_deleted_tastings_lists_restorable_records_until_restored(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix, quantity=1)
    tasting = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": setup["bottle_ids"][0], "tasted_on": "2026-10-01", "rating": "4"},
    ).json()
    assert api_client.get(f"{prefix}/tastings/deleted").json() == []
    removed = api_client.request(
        "DELETE",
        f"{prefix}/tastings/{tasting['id']}",
        json={
            "request_id": "01990000-0000-7000-8000-00000000d010",
            "expected_updated_at": tasting["updated_at"],
        },
    ).json()

    listed = api_client.get(f"{prefix}/tastings/deleted").json()

    assert [item["id"] for item in listed] == [tasting["id"]]
    assert listed[0]["context"]["product_name"] == "무결성 위스키"
    assert listed[0]["deleted_at"] is not None
    assert datetime.datetime.fromisoformat(
        listed[0]["updated_at"]
    ) == datetime.datetime.fromisoformat(removed["updated_at"])
    restored = api_client.post(
        f"{prefix}/tastings/{tasting['id']}:restore",
        json={
            "request_id": "01990000-0000-7000-8000-00000000d011",
            "expected_updated_at": listed[0]["updated_at"],
        },
    )
    assert restored.status_code == 200, restored.text
    assert api_client.get(f"{prefix}/tastings/deleted").json() == []


def test_recently_deleted_tastings_hides_records_of_deleted_products(
    api_client: TestClient, prefix: str
) -> None:
    setup = _purchase_with_bottles(api_client, prefix, quantity=1)
    tasting = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": setup["bottle_ids"][0], "tasted_on": "2026-10-01"},
    ).json()
    api_client.request(
        "DELETE",
        f"{prefix}/tastings/{tasting['id']}",
        json={
            "request_id": "01990000-0000-7000-8000-00000000d012",
            "expected_updated_at": tasting["updated_at"],
        },
    )
    assert api_client.delete(f"{prefix}/products/{setup['product_id']}").status_code == 204

    assert api_client.get(f"{prefix}/tastings/deleted").json() == []


def test_purchase_delete_locks_purchase_before_its_bottles(
    api_client: TestClient, prefix: str
) -> None:
    """병수 수정과 같은 구매 → 병 순서로 잠가 두 기기의 수정·삭제가 교착하지 않게 한다."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    import psycopg

    from sooljang.config import get_settings

    setup = _purchase_with_bottles(api_client, prefix, quantity=1)
    url = str(get_settings().database_url).replace("postgresql+psycopg://", "postgresql://")
    # 실패해도 연결이 먼저 닫혀(잠금 해제) 기다리던 요청이 끝나도록 pool 을 바깥에 둔다.
    with (
        ThreadPoolExecutor(1) as pool,
        psycopg.connect(url) as resize,
        psycopg.connect(url, autocommit=True) as probe,
    ):
        resize.execute("SELECT id FROM purchase WHERE id = %s FOR UPDATE", (setup["purchase_id"],))
        pending = pool.submit(api_client.delete, f"{prefix}/purchases/{setup['purchase_id']}")
        time.sleep(1)
        assert not pending.done(), "삭제가 구매 행 잠금을 기다리지 않았다"
        # 삭제가 병을 먼저 잠갔다면 이 조회가 바로 실패한다(교착의 반쪽).
        probe.execute(
            "SELECT id FROM bottle WHERE purchase_id = %s FOR UPDATE NOWAIT",
            (setup["purchase_id"],),
        )
        resize.commit()
        response = pending.result(timeout=30)

    assert response.status_code == 204, response.text
