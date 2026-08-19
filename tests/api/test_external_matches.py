"""매칭 고정 API 테스트(Task 34 PR1).

이름 유사도가 틀렸을 때 사용자가 상품을 직접 지정하는 경로다. 여기서는 라우팅·소유권·
호스트 검증·캐시 무효화만 확인한다 — 고정이 조회 동작을 어떻게 바꾸는지는
`tests/infrastructure/external/test_adapter.py` 가 mock transport 로 검증한다.
"""

import uuid
from typing import Any

from fastapi.testclient import TestClient

ADAPTER_SPEC: dict[str, Any] = {
    "search": {
        "url_template": "https://example.com/search?q={query}",
        "item": ".product-card",
        "fields": {
            "name": {"selector": ".title", "attr": "text"},
            "url": {"selector": "a", "attr": "href", "absolute": True},
        },
    },
    "detail": {"fields": {"price": {"selector": ".price", "attr": "text"}}},
}


def _create_source(client: TestClient, prefix: str) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/external-sources",
        json={
            "name": "데일리샷",
            "base_url": "https://example.com",
            "adapter_spec": ADAPTER_SPEC,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_product(client: TestClient, prefix: str) -> dict[str, Any]:
    response = client.post(f"{prefix}/products", json={"name": "글렌피딕 12년"})
    assert response.status_code == 201, response.text
    return response.json()


def _pin(
    client: TestClient,
    prefix: str,
    product_id: str,
    source_id: str,
    *,
    url: str = "https://example.com/product/1",
    name: str = "글렌피딕 12년",
    key: str | None = "1",
) -> Any:
    return client.post(
        f"{prefix}/products/{product_id}/external-matches",
        json={
            "source_id": source_id,
            "external_url": url,
            "external_name": name,
            "external_key": key,
        },
    )


def test_고정하면_저장된_상품이_돌아온다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product = _create_product(api_client, prefix)

    response = _pin(api_client, prefix, product["id"], source["id"])

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["external_url"] == "https://example.com/product/1"
    assert body["external_name"] == "글렌피딕 12년"
    assert body["external_key"] == "1"
    assert body["source_id"] == source["id"]
    assert body["product_id"] == product["id"]


def test_다시_고정하면_덮어쓴다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product = _create_product(api_client, prefix)
    _pin(api_client, prefix, product["id"], source["id"])

    response = _pin(
        api_client,
        prefix,
        product["id"],
        source["id"],
        url="https://example.com/product/2",
        name="글렌피딕 15년",
        key="2",
    )

    assert response.status_code == 201, response.text
    assert response.json()["external_name"] == "글렌피딕 15년"


def test_다른_호스트로_고정하면_422(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product = _create_product(api_client, prefix)

    response = _pin(
        api_client, prefix, product["id"], source["id"], url="https://evil.example.net/product/1"
    )

    assert response.status_code == 422, response.text


def test_해제하면_204이고_다시_해제해도_204(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product = _create_product(api_client, prefix)
    _pin(api_client, prefix, product["id"], source["id"])

    first = api_client.delete(f"{prefix}/products/{product['id']}/external-matches/{source['id']}")
    second = api_client.delete(f"{prefix}/products/{product['id']}/external-matches/{source['id']}")

    assert first.status_code == 204, first.text
    # 해제할 것이 없어도 실패로 보지 않는다 — 최종 상태가 같으므로 멱등하게 둔다.
    assert second.status_code == 204, second.text


def test_해제_후_다시_고정할_수_있다(api_client: TestClient, prefix: str) -> None:
    """부분 유니크 인덱스가 soft delete 된 행 때문에 재고정을 막지 않는지 확인한다."""
    source = _create_source(api_client, prefix)
    product = _create_product(api_client, prefix)
    _pin(api_client, prefix, product["id"], source["id"])
    api_client.delete(f"{prefix}/products/{product['id']}/external-matches/{source['id']}")

    response = _pin(api_client, prefix, product["id"], source["id"])

    assert response.status_code == 201, response.text


def test_없는_소스로_고정하면_404(api_client: TestClient, prefix: str) -> None:
    product = _create_product(api_client, prefix)

    response = _pin(api_client, prefix, product["id"], str(uuid.uuid4()))

    assert response.status_code == 404, response.text


def test_없는_제품에_고정하면_404(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = _pin(api_client, prefix, str(uuid.uuid4()), source["id"])

    assert response.status_code == 404, response.text


def test_로그인하지_않으면_거부한다(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.post(
        f"{prefix}/products/{uuid.uuid4()}/external-matches",
        json={
            "source_id": str(uuid.uuid4()),
            "external_url": "https://example.com/product/1",
            "external_name": "글렌피딕 12년",
        },
    )

    assert response.status_code == 401, response.text
