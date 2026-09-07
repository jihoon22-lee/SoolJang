"""관심 CRUD는 구매·재고를 늘리지 않고 출처·동시 수정 경계를 보존한다."""

import uuid

from fastapi.testclient import TestClient


def test_interest_save_archive_and_restore_preserve_identity_without_purchase(
    api_client: TestClient, prefix: str
) -> None:
    initial = api_client.get(f"{prefix}/stats/summary").json()
    response = api_client.post(
        f"{prefix}/interests",
        json={"identity": {"name": "관심 합성 술", "volumes_ml": [700]}, "note": "다음에 비교"},
    )
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["product_id"] is None
    original_identity = row["identity"]
    path = f"{prefix}/interests/{row['id']}"
    updated = api_client.patch(
        path,
        json={"note": "갱신한 노트", "archived": True, "expected_updated_at": row["updated_at"]},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["archived"]
    stale = api_client.patch(
        path, json={"note": "오래된 화면", "expected_updated_at": row["updated_at"]}
    )
    assert stale.status_code == 409
    restored = api_client.patch(
        path, json={"archived": False, "expected_updated_at": updated.json()["updated_at"]}
    )
    assert restored.status_code == 200
    assert restored.json()["identity"] == original_identity
    assert not restored.json()["archived"]
    assert api_client.get(f"{prefix}/stats/summary").json() == initial
    assert api_client.get(f"{prefix}/purchases").json() == []
    assert api_client.get(f"{prefix}/interests").json()[0]["id"] == row["id"]


def test_interest_source_pin_validates_source_and_public_http_url(
    api_client: TestClient, prefix: str
) -> None:
    source = api_client.post(
        f"{prefix}/external-sources",
        json={"name": "합성 출처", "base_url": "https://example.com", "adapter_spec": {}},
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    pin = {
        "product_key": "sample-whisky",
        "external_url": "https://example.com/products/sample",
        "external_key": "sample",
        "external_name": "합성 술",
    }
    payload = {"identity": {"name": "합성 술"}, "source_matches": {source_id: pin}}
    response = api_client.post(f"{prefix}/interests", json=payload)
    assert response.status_code == 201, response.text
    assert response.json()["source_matches"] == {source_id: pin}
    for url in (
        "javascript:alert(1)",
        "http://127.0.0.1/private",
        "https://user:pass@example.com/product",
        "https://example.com/\nproduct",
    ):
        payload["source_matches"] = {source_id: {**pin, "external_url": url}}
        assert api_client.post(f"{prefix}/interests", json=payload).status_code == 422
    payload["source_matches"] = {str(uuid.uuid4()): pin}
    assert api_client.post(f"{prefix}/interests", json=payload).status_code == 404
    assert len(api_client.get(f"{prefix}/interests").json()) == 1


def test_interest_identity_update_preserves_other_fields_and_requires_revision(
    api_client: TestClient, prefix: str
) -> None:
    row = api_client.post(
        f"{prefix}/interests", json={"identity": {"name": "처음 이름"}, "note": "보존"}
    ).json()
    path = f"{prefix}/interests/{row['id']}"
    assert api_client.patch(path, json={"note": "revision 없음"}).status_code == 422
    assert (
        api_client.patch(
            path, json={"identity": None, "expected_updated_at": row["updated_at"]}
        ).status_code
        == 422
    )
    response = api_client.patch(
        path,
        json={
            "identity": {"name": "확인한 이름", "abv": "43"},
            "expected_updated_at": row["updated_at"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "확인한 이름"
    assert response.json()["note"] == "보존"


def test_repeated_interest_save_reuses_the_same_stable_id(
    api_client: TestClient, prefix: str
) -> None:
    payload = {"request_id": str(uuid.uuid4()), "identity": {"name": "반복 저장 합성"}}
    first = api_client.post(f"{prefix}/interests", json=payload)
    second = api_client.post(f"{prefix}/interests", json=payload)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert len(api_client.get(f"{prefix}/interests").json()) == 1
    payload["identity"] = {"name": "다른 관심"}
    assert api_client.post(f"{prefix}/interests", json=payload).status_code == 409
