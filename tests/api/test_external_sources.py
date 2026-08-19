"""외부 소스 레지스트리·조회 API 테스트.

조회의 실제 fetch 로직(robots.txt, rate limit, 셀렉터 파싱)은
`tests/infrastructure/database/test_external_sources.py`, `tests/infrastructure/external/
test_adapter.py` 가 mock transport 로 이미 검증한다 — 여기서는 라우팅·스키마·인증·소유권만
확인한다.
"""

from typing import Any

from fastapi.testclient import TestClient

ADAPTER_SPEC = {
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


def _create_source(client: TestClient, prefix: str, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "데일리샷",
        "base_url": "https://example.com",
        "adapter_spec": ADAPTER_SPEC,
    }
    payload.update(overrides)
    response = client.post(f"{prefix}/external-sources", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_등록하면_목록에_나타난다(api_client: TestClient, prefix: str) -> None:
    _create_source(api_client, prefix)

    response = api_client.get(f"{prefix}/external-sources")

    assert response.status_code == 200, response.text
    names = [source["name"] for source in response.json()]
    assert names == ["데일리샷"]


def test_기본값이_채워진다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    assert source["priority"] == 0
    assert source["is_active"] is True
    assert source["rate_limit_per_min"] == 6
    assert source["ttl_hours"] == 24
    assert source["category_id"] is None


def test_수정하면_반영된다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = api_client.patch(
        f"{prefix}/external-sources/{source['id']}",
        json={"is_active": False, "priority": 5},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["is_active"] is False
    assert body["priority"] == 5
    assert body["name"] == "데일리샷"


def test_수정하면_이름의_앞뒤_공백을_지운다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = api_client.patch(
        f"{prefix}/external-sources/{source['id']}", json={"name": "  새 이름  "}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "새 이름"


def test_수정시_존재하지_않는_카테고리면_404(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = api_client.patch(
        f"{prefix}/external-sources/{source['id']}",
        json={"category_id": "00000000-0000-0000-0000-0000000000ff"},
    )

    assert response.status_code == 404, response.text


def test_존재하지_않는_카테고리로_등록하면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/external-sources",
        json={
            "name": "데일리샷",
            "base_url": "https://example.com",
            "adapter_spec": ADAPTER_SPEC,
            "category_id": "00000000-0000-0000-0000-0000000000ff",
        },
    )

    assert response.status_code == 404, response.text


def test_없는_소스를_수정하면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.patch(
        f"{prefix}/external-sources/00000000-0000-0000-0000-0000000000ff",
        json={"priority": 1},
    )
    assert response.status_code == 404, response.text


def test_삭제하면_목록에서_빠진다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    delete_response = api_client.delete(f"{prefix}/external-sources/{source['id']}")
    assert delete_response.status_code == 204, delete_response.text

    response = api_client.get(f"{prefix}/external-sources")
    assert response.json() == []


def test_이름이_비어있으면_거부한다(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/external-sources",
        json={"name": "", "base_url": "https://example.com", "adapter_spec": ADAPTER_SPEC},
    )
    assert response.status_code == 422, response.text


def test_로그인하지_않으면_거부한다(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.get(f"{prefix}/external-sources")
    assert response.status_code == 401, response.text


def test_제품이_없으면_조회는_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/products/00000000-0000-0000-0000-0000000000ff/external-lookup"
    )
    assert response.status_code == 404, response.text


def test_등록된_소스가_없으면_조회는_빈_목록(api_client: TestClient, prefix: str) -> None:
    product_response = api_client.post(f"{prefix}/products", json={"name": "글렌피딕 12년"})
    assert product_response.status_code == 201, product_response.text
    product_id = product_response.json()["id"]

    response = api_client.post(f"{prefix}/products/{product_id}/external-lookup")

    assert response.status_code == 200, response.text
    assert response.json() == []


# --- 매칭 고정(Task 34 PR1, §7.4) --------------------------------------------


def _create_product(client: TestClient, prefix: str, name: str = "글렌피딕 12년") -> str:
    response = client.post(f"{prefix}/products", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_고정하면_201과_값을_반환한다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product_id = _create_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/products/{product_id}/external-matches",
        json={
            "source_id": source["id"],
            "external_url": "https://example.com/product/1",
            "external_name": "글렌피딕 12년 고정본",
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["external_url"] == "https://example.com/product/1"
    assert body["external_name"] == "글렌피딕 12년 고정본"
    assert body["source_id"] == source["id"]
    assert body["product_id"] == product_id


def test_다른_호스트_URL로_고정하면_422(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product_id = _create_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/products/{product_id}/external-matches",
        json={
            "source_id": source["id"],
            "external_url": "https://evil.example/product/1",
            "external_name": "가짜",
        },
    )

    assert response.status_code == 422, response.text


def test_없는_소스에_고정하면_404(api_client: TestClient, prefix: str) -> None:
    product_id = _create_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/products/{product_id}/external-matches",
        json={
            "source_id": "00000000-0000-0000-0000-0000000000ff",
            "external_url": "https://example.com/product/1",
            "external_name": "X",
        },
    )

    assert response.status_code == 404, response.text


def test_없는_제품에_고정하면_404(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = api_client.post(
        f"{prefix}/products/00000000-0000-0000-0000-0000000000ff/external-matches",
        json={
            "source_id": source["id"],
            "external_url": "https://example.com/product/1",
            "external_name": "X",
        },
    )

    assert response.status_code == 404, response.text


def test_고정을_해제하면_204(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product_id = _create_product(api_client, prefix)
    create_response = api_client.post(
        f"{prefix}/products/{product_id}/external-matches",
        json={
            "source_id": source["id"],
            "external_url": "https://example.com/product/1",
            "external_name": "X",
        },
    )
    assert create_response.status_code == 201, create_response.text

    response = api_client.delete(f"{prefix}/products/{product_id}/external-matches/{source['id']}")

    assert response.status_code == 204, response.text


def test_없는_고정을_해제하면_404(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    product_id = _create_product(api_client, prefix)

    response = api_client.delete(f"{prefix}/products/{product_id}/external-matches/{source['id']}")

    assert response.status_code == 404, response.text
