"""바코드 조회 API 테스트."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from sooljang.infrastructure.external import open_food_facts


def _seed_product_with_barcode(
    client: TestClient, prefix: str, *, name: str, barcode: str
) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/products",
        json={"name": name, "skus": [{"volume_ml": 700, "barcode": barcode}]},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_local_match_returns_existing_product(api_client: TestClient, prefix: str) -> None:
    product = _seed_product_with_barcode(
        api_client, prefix, name="가상 위스키", barcode="8801234567890"
    )

    response = api_client.get(f"{prefix}/barcodes/8801234567890")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "local"
    assert body["barcode"] == "8801234567890"
    assert body["local_match"]["product_id"] == product["id"]
    assert body["local_match"]["sku_id"] == product["skus"][0]["id"]


def test_local_match_normalizes_upca_to_ean13(api_client: TestClient, prefix: str) -> None:
    """매장에서는 UPC-A 로 찍힌 스캔이라도 EAN-13 으로 저장된 규격과 매칭돼야 한다."""
    _seed_product_with_barcode(api_client, prefix, name="가상 버번", barcode="012345678905")

    response = api_client.get(f"{prefix}/barcodes/012345678905")

    assert response.status_code == 200, response.text
    assert response.json()["source"] == "local"
    assert response.json()["barcode"] == "0012345678905"


def test_external_suggestion_when_not_registered_locally(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_lookup(barcode: str, *, transport: object = None) -> object:
        assert barcode == "8801234500009"
        return open_food_facts.OpenFoodFactsProduct(
            barcode=barcode,
            name="외부 제안 위스키",
            brand="가상 브랜드",
            quantity_text="700 ml",
            image_url=None,
        )

    monkeypatch.setattr(open_food_facts, "lookup", fake_lookup)

    response = api_client.get(f"{prefix}/barcodes/8801234500009")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "external"
    assert body["external_suggestion"]["name"] == "외부 제안 위스키"
    assert body["external_suggestion"]["source_url"] == (
        "https://world.openfoodfacts.org/product/8801234500009"
    )
    assert body["local_match"] is None


def test_not_found_when_neither_local_nor_external(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_lookup(barcode: str, *, transport: object = None) -> None:
        return None

    monkeypatch.setattr(open_food_facts, "lookup", fake_lookup)

    response = api_client.get(f"{prefix}/barcodes/8801234500009")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "not_found"
    assert body["local_match"] is None
    assert body["external_suggestion"] is None


def test_rcn_range_skips_external_lookup_and_warns(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    async def fake_lookup(barcode: str, *, transport: object = None) -> None:
        calls.append(barcode)
        return None

    monkeypatch.setattr(open_food_facts, "lookup", fake_lookup)

    response = api_client.get(f"{prefix}/barcodes/2000010000059")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["is_rcn"] is True
    assert body["barcode_type"] == "rcn"
    assert calls == []  # RCN 은 전역 조회가 의미 없어 외부 호출을 건너뛴다.


def test_invalid_barcode_format_returns_422(api_client: TestClient, prefix: str) -> None:
    response = api_client.get(f"{prefix}/barcodes/not-a-barcode")

    assert response.status_code == 422, response.text
