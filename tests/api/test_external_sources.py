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


def test_소스가_없으면_헬스는_빈_목록(api_client: TestClient, prefix: str) -> None:
    response = api_client.get(f"{prefix}/external-sources/health")

    assert response.status_code == 200, response.text
    assert response.json() == []


def test_이력이_없으면_헬스_상태는_unknown(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = api_client.get(f"{prefix}/external-sources/health")

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body) == 1
    assert body[0]["source_id"] == source["id"]
    assert body[0]["status"] == "unknown"
    assert body[0]["consecutive_failures"] == 0


def test_헬스_조회는_로그인하지_않으면_거부한다(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.get(f"{prefix}/external-sources/health")
    assert response.status_code == 401, response.text


def test_없는_소스로_테스트_조회하면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/external-sources/00000000-0000-0000-0000-0000000000ff/probe",
        json={"name": "글렌피딕 12년"},
    )
    assert response.status_code == 404, response.text


# --- 프리셋 카탈로그와 자격 증명 (Task 34 PR5) -----------------------------------


def test_프리셋_카탈로그를_조회한다(api_client: TestClient, prefix: str) -> None:
    response = api_client.get(f"{prefix}/external-sources/presets")

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body) > 0
    dailyshot = next(p for p in body if p["key"] == "dailyshot")
    assert dailyshot["name"] == "데일리샷"
    assert dailyshot["base_url"] == "https://dailyshot.co"
    assert dailyshot["version"] == 2
    # 등록 시점에 서버가 채우는 구현 세부사항이라 응답에 adapter_spec 은 없다.
    assert "adapter_spec" not in dailyshot


def test_프리셋_카탈로그_조회도_로그인이_필요하다(anon_client: TestClient, prefix: str) -> None:
    """이 라우터는 전체가 `protected` 의존성 아래 묶여 있다(app.py) — 목록이라고 예외는 아니다."""
    response = anon_client.get(f"{prefix}/external-sources/presets")
    assert response.status_code == 401, response.text


def test_프리셋_키로_소스를_등록한다(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(f"{prefix}/external-sources", json={"preset_key": "dailyshot"})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "데일리샷"
    assert body["base_url"] == "https://dailyshot.co"
    assert body["preset_key"] == "dailyshot"
    assert body["preset_version"] == 2
    assert body["spec_overridden"] is False


def test_없는_프리셋_키로_등록하면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(f"{prefix}/external-sources", json={"preset_key": "존재하지-않음"})
    assert response.status_code == 404, response.text


def test_preset_key도_커스텀_필드도_없으면_422(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(f"{prefix}/external-sources", json={})
    assert response.status_code == 422, response.text


def test_프리셋_소스의_스펙을_고치면_spec_overridden이_true가_된다(
    api_client: TestClient, prefix: str
) -> None:
    source = api_client.post(f"{prefix}/external-sources", json={"preset_key": "dailyshot"}).json()

    response = api_client.patch(
        f"{prefix}/external-sources/{source['id']}",
        json={"adapter_spec": {"search": {"url_template": "https://x/{query}"}}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["spec_overridden"] is True


def test_자격_증명을_저장하면_힌트만_돌아온다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)

    response = api_client.put(
        f"{prefix}/external-sources/{source['id']}/credentials",
        json={"values": {"api_key": "sk-abcdef1234"}},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"hints": {"api_key": "1234"}}
    # 원문이 응답 어디에도 없어야 한다.
    assert "sk-abcdef1234" not in response.text


def test_저장된_자격_증명_힌트가_소스_조회에_함께_온다(api_client: TestClient, prefix: str) -> None:
    source = _create_source(api_client, prefix)
    api_client.put(
        f"{prefix}/external-sources/{source['id']}/credentials",
        json={"values": {"api_key": "sk-abcdef1234"}},
    )

    response = api_client.get(f"{prefix}/external-sources")

    assert response.status_code == 200, response.text
    body = next(s for s in response.json() if s["id"] == source["id"])
    assert body["credential_hints"] == {"api_key": "1234"}


def test_없는_소스에_자격_증명을_저장하면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.put(
        f"{prefix}/external-sources/00000000-0000-0000-0000-0000000000ff/credentials",
        json={"values": {"api_key": "sk-abcdef1234"}},
    )
    assert response.status_code == 404, response.text


def test_자격_증명_저장은_로그인하지_않으면_거부한다(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.put(
        f"{prefix}/external-sources/00000000-0000-0000-0000-0000000000ff/credentials",
        json={"values": {"api_key": "sk-abcdef1234"}},
    )
    assert response.status_code == 401, response.text
