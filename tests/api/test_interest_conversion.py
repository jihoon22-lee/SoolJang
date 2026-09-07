"""관심 구매 전환은 원자적으로 실행하고 응답 유실 재시도를 중복 구매로 만들지 않는다."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient


def test_new_product_conversion_retries_preserve_interest_and_single_purchase(
    api_client: TestClient, prefix: str
) -> None:
    row = api_client.post(
        f"{prefix}/interests",
        json={"identity": {"name": "관심 합성 술", "volumes_ml": [700]}, "note": "관심 메모"},
    ).json()
    payload = {
        "expected_updated_at": row["updated_at"],
        "confirmed_identity": True,
        "new_product": {"name": "확정 합성 술", "volume_ml": 700, "abv": "43"},
        "quantity": 2,
        "unit_paid_price": "0",
    }
    path = f"{prefix}/interests/{row['id']}/purchase"
    first = api_client.post(path, json=payload)
    assert first.status_code == 201, first.text
    assert api_client.post(path, json=payload).json() == first.json()
    purchases = api_client.get(f"{prefix}/purchases").json()
    assert len(purchases) == 1
    assert purchases[0]["quantity"] == 2 and purchases[0]["paid_total"] == "0.00"
    assert len(api_client.get(f"{prefix}/purchases/{purchases[0]['id']}/bottles").json()) == 2
    current = api_client.get(f"{prefix}/interests").json()[0]
    assert current["id"] == row["id"] and current["identity"] == row["identity"]
    assert current["archived"] and current["note"] == "관심 메모"
    assert current["product_id"] == first.json()["product_id"]
    assert api_client.post(path, json={**payload, "quantity": 3}).status_code == 409


def test_existing_sku_conversion_rejects_unconfirmed_and_stale_interest(
    api_client: TestClient, prefix: str
) -> None:
    product = api_client.post(
        f"{prefix}/products", json={"name": "기존 합성 술", "skus": [{"volume_ml": 700}]}
    ).json()
    row = api_client.post(f"{prefix}/interests", json={"identity": {"name": "관심 합성 술"}}).json()
    payload = {
        "expected_updated_at": row["updated_at"],
        "confirmed_identity": True,
        "sku_id": product["skus"][0]["id"],
    }
    path = f"{prefix}/interests/{row['id']}/purchase"
    assert api_client.post(path, json={**payload, "confirmed_identity": False}).status_code == 422
    updated = api_client.patch(
        f"{prefix}/interests/{row['id']}",
        json={"note": "새 정보", "expected_updated_at": row["updated_at"]},
    ).json()
    assert api_client.post(path, json=payload).status_code == 409
    response = api_client.post(path, json={**payload, "expected_updated_at": updated["updated_at"]})
    assert response.status_code == 201, response.text
    assert response.json()["product_id"] == product["id"]
    assert len(api_client.get(f"{prefix}/products").json()["items"]) == 1


def test_failed_conversion_rolls_back_new_product_and_preserves_interest(
    api_client: TestClient, prefix: str
) -> None:
    row = api_client.post(
        f"{prefix}/interests", json={"identity": {"name": "실패 후 재시도 술"}}
    ).json()
    payload = {
        "expected_updated_at": row["updated_at"],
        "confirmed_identity": True,
        "new_product": {"name": "미완료 생성 술", "volume_ml": 700},
        "vendor_id": str(uuid.uuid4()),
    }
    assert (
        api_client.post(f"{prefix}/interests/{row['id']}/purchase", json=payload).status_code == 404
    )
    assert api_client.get(f"{prefix}/products").json()["items"] == []
    assert api_client.get(f"{prefix}/purchases").json() == []
    assert not api_client.get(f"{prefix}/interests").json()[0]["archived"]


def test_two_sessions_convert_one_interest_into_one_purchase(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from sooljang.application import interest_conversion as service
    from sooljang.infrastructure.database.models import Interest

    row = api_client.post(f"{prefix}/interests", json={"identity": {"name": "동시 전환 술"}}).json()
    first_headers = {
        "Cookie": "; ".join(f"{key}={value}" for key, value in api_client.cookies.items()),
        "X-CSRF-Token": api_client.headers["X-CSRF-Token"],
    }
    login = api_client.post(
        f"{prefix}/auth/login",
        json={"email": "owner@example.com", "password": "sooljang-test-1234"},
    )
    assert login.status_code == 200
    api_client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    payload = {
        "expected_updated_at": row["updated_at"],
        "confirmed_identity": True,
        "new_product": {"name": "동시 확정 술", "volume_ml": 700},
    }
    path = f"{prefix}/interests/{row['id']}/purchase"
    held, release, started, second_read = (threading.Event() for _ in range(4))
    original = service.owned
    calls = 0

    async def paused_owned(
        session: Any, model: Any, user_id: uuid.UUID, entity_id: uuid.UUID
    ) -> Any:
        nonlocal calls
        if model is not Interest:
            return await original(session, model, user_id, entity_id)
        calls += 1
        index = calls
        if index == 2:
            started.set()
        result = await original(session, model, user_id, entity_id)
        if index == 1:
            held.set()
            assert await asyncio.to_thread(release.wait, 5)
        else:
            second_read.set()
        return result

    monkeypatch.setattr(service, "owned", paused_owned)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(api_client.post, path, json=payload, headers=first_headers)
        assert held.wait(3)
        second = pool.submit(api_client.post, path, json=payload)
        try:
            assert started.wait(3)
            assert not second_read.wait(0.2)
        finally:
            release.set()
        first_response, second_response = first.result(timeout=5), second.result(timeout=5)
    assert first_response.status_code == second_response.status_code == 201
    assert first_response.json() == second_response.json()
    assert len(api_client.get(f"{prefix}/purchases").json()) == 1
