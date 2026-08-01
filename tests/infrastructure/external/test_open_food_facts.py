"""Open Food Facts 클라이언트 테스트.

실제 네트워크를 타지 않는다 — `httpx.MockTransport` 로 응답을 흉내 낸다.
"""

import httpx

from sooljang.infrastructure.external import open_food_facts


async def test_found_product_is_parsed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v2/product/8801234567890.json"
        return httpx.Response(
            200,
            json={
                "status": 1,
                "product": {
                    "product_name": "가상 위스키 12년",
                    "brands": "가상 증류소",
                    "quantity": "700 ml",
                    "image_url": "https://images.example/8801234567890.jpg",
                },
            },
        )

    result = await open_food_facts.lookup("8801234567890", transport=httpx.MockTransport(handler))

    assert result is not None
    assert result.name == "가상 위스키 12년"
    assert result.brand == "가상 증류소"
    assert result.quantity_text == "700 ml"
    assert result.image_url == "https://images.example/8801234567890.jpg"
    assert result.source_url == "https://world.openfoodfacts.org/product/8801234567890"


async def test_status_zero_means_not_found() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"status": 0}))
    result = await open_food_facts.lookup("0000000000000", transport=transport)
    assert result is None


async def test_missing_product_name_is_treated_as_not_found() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"status": 1, "product": {}})
    )
    result = await open_food_facts.lookup("8801234567890", transport=transport)
    assert result is None


async def test_http_error_is_swallowed() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(500))
    result = await open_food_facts.lookup("8801234567890", transport=transport)
    assert result is None


async def test_network_failure_is_swallowed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    transport = httpx.MockTransport(handler)
    result = await open_food_facts.lookup("8801234567890", transport=transport)
    assert result is None


async def test_malformed_json_is_swallowed() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"not json"))
    result = await open_food_facts.lookup("8801234567890", transport=transport)
    assert result is None
