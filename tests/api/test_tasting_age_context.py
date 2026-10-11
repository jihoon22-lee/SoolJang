"""실브라우저에서 발견한 숙성 연수 Decimal의 시음 맥락 직렬화 회귀."""

from fastapi.testclient import TestClient

from tests.api.test_tastings import _create_product_with_bottle


def test_aged_spirit_tasting_and_correction_contexts_are_readable(
    api_client: TestClient, prefix: str
) -> None:
    setup = _create_product_with_bottle(api_client, prefix)
    bottle_id = setup["bottles"][0]["id"]
    sku = api_client.get(f"{prefix}/products").json()["items"][0]
    response = api_client.patch(f"{prefix}/products/{sku['id']}", json={"age_years": "12.5"})
    assert response.status_code == 200
    created = api_client.post(
        f"{prefix}/tastings",
        json={"bottle_id": bottle_id, "tasted_on": "2026-10-11", "rating": "4.5"},
    )
    assert created.status_code == 201, created.text
    tasting_id = created.json()["id"]
    endpoints = [
        (f"{prefix}/tastings/{tasting_id}", False),
        (f"{prefix}/tastings/page", True),
        (f"{prefix}/bottles/{bottle_id}/tastings/page", True),
        (f"{prefix}/bottles/{bottle_id}/correction-context", False),
    ]
    for endpoint, paged in endpoints:
        result = api_client.get(endpoint)
        assert result.status_code == 200, result.text
        record = result.json()["items"][0] if paged else result.json()
        assert record["context"]["age_years"] == "12.5"
        assert record["context"]["abv"] == "46.00"
