"""검색 별칭은 확인한 사용자 입력이며 제품 동일성 키를 바꾸지 않는다."""

import uuid

from fastapi.testclient import TestClient

from tests.api.test_sync import _batch, _op, _pull


def test_aliases_survive_edit_and_match_server_search(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/products",
        json={
            "name": "GlenAllachie 12",
            "search_aliases": ["내 셰리 위스키"],
            "skus": [{"volume_ml": 700}],
        },
    )
    assert response.status_code == 201
    product = response.json()
    assert product["search_aliases"] == ["내 셰리 위스키"]
    for query in ("글렌알라키 12년", "내 셰리", "ㄱㄹㅇㄹㅋ"):
        result = api_client.get(f"{prefix}/products", params={"q": query}).json()
        assert [item["id"] for item in result["items"]] == [product["id"]]
    assert (
        api_client.get(f"{prefix}/products", params={"q": "글렌알라키 15년"}).json()["items"] == []
    )
    changed = api_client.patch(
        f"{prefix}/products/{product['id']}", json={"note": "별칭 유지"}
    ).json()
    assert changed["search_aliases"] == ["내 셰리 위스키"]
    for aliases in ([""], ["x"] * 21, None):
        assert (
            api_client.patch(
                f"{prefix}/products/{product['id']}", json={"search_aliases": aliases}
            ).status_code
            == 422
        )


def test_offline_aliases_roundtrip_and_reject_invalid_input(
    api_client: TestClient, prefix: str
) -> None:
    product_id = uuid.uuid4()
    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="product",
                op="create",
                entity_id=product_id,
                fields={"name": "GlenAllachie 12", "search_aliases": [" 내 셰리 "]},
            )
        ],
    )
    assert result["results"][0]["status"] == "applied"
    product = next(
        row
        for row in _pull(api_client, prefix)["changes"]["product"]
        if row["id"] == str(product_id)
    )
    assert product["search_aliases"] == ["내 셰리"]
    assert api_client.get(f"{prefix}/products", params={"q": "내 셰리"}).json()["items"][0][
        "id"
    ] == str(product_id)
    for aliases in (None, [""], ["x"] * 21):
        invalid = _batch(
            api_client,
            prefix,
            [
                _op(
                    entity="product",
                    op="update",
                    entity_id=product_id,
                    base_updated_at=product["updated_at"],
                    fields={"search_aliases": aliases},
                )
            ],
        )
        assert invalid["results"][0]["status"] == "failed"
    assert api_client.get(f"{prefix}/products/{product_id}").json()["search_aliases"] == ["내 셰리"]
