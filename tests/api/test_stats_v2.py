"""통계 v2(피벗·시계열) API 테스트(Task 20)."""

from typing import Any

from fastapi.testclient import TestClient


def _seed_category(client: TestClient, prefix: str, *, name: str) -> str:
    response = client.post(f"{prefix}/categories", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _seed_vendor(client: TestClient, prefix: str, *, name: str) -> str:
    response = client.post(f"{prefix}/vendors", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _seed_product(
    client: TestClient,
    prefix: str,
    *,
    name: str,
    category_id: str | None = None,
    country: str | None = None,
    vintage: int | None = None,
    rating: str | None = None,
    volume_ml: int = 700,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": name, "skus": [{"volume_ml": volume_ml}]}
    if category_id is not None:
        payload["category_id"] = category_id
    if country is not None:
        payload["country"] = country
    if vintage is not None:
        payload["vintage"] = vintage
    if rating is not None:
        payload["personal_rating"] = rating
    response = client.post(f"{prefix}/products", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _add_purchase(
    client: TestClient,
    prefix: str,
    *,
    sku_id: str,
    quantity: int = 1,
    vendor_id: str | None = None,
    purchased_on: str | None = None,
    unit_list_price: str | None = None,
    unit_paid_price: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"sku_id": sku_id, "quantity": quantity}
    if vendor_id is not None:
        payload["vendor_id"] = vendor_id
    if purchased_on is not None:
        payload["purchased_on"] = purchased_on
    if unit_list_price is not None:
        payload["unit_list_price"] = unit_list_price
    if unit_paid_price is not None:
        payload["unit_paid_price"] = unit_paid_price
    response = client.post(f"{prefix}/purchases", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- 피벗 ---------------------------------------------------------------------


def test_pivot_endpoints_require_auth(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.post(
        f"{prefix}/stats/pivot", json={"row_dimension": "vendor", "metric": "bottle_count"}
    )
    assert response.status_code == 401, response.text


def test_구매처_x_주종_평균_할인율_피벗(api_client: TestClient, prefix: str) -> None:
    """데모 시나리오: "구매처별 × 주종별 평균 할인율" 뷰."""
    whiskey = _seed_category(api_client, prefix, name="위스키")
    wine = _seed_category(api_client, prefix, name="와인")
    mart = _seed_vendor(api_client, prefix, name="가상마트")
    online = _seed_vendor(api_client, prefix, name="가상몰")

    p1 = _seed_product(api_client, prefix, name="위스키A", category_id=whiskey)
    _add_purchase(
        api_client,
        prefix,
        sku_id=p1["skus"][0]["id"],
        vendor_id=mart,
        unit_list_price="100000",
        unit_paid_price="80000",
    )

    p2 = _seed_product(api_client, prefix, name="와인A", category_id=wine)
    _add_purchase(
        api_client,
        prefix,
        sku_id=p2["skus"][0]["id"],
        vendor_id=online,
        unit_list_price="50000",
        unit_paid_price="45000",
    )

    response = api_client.post(
        f"{prefix}/stats/pivot",
        json={"row_dimension": "vendor", "column_dimension": "category", "metric": "discount_rate"},
    )
    assert response.status_code == 200, response.text
    cells = response.json()

    mart_cell = next(c for c in cells if c["row_label"] == "가상마트")
    assert mart_cell["column_label"] == "위스키"
    assert mart_cell["value"] == "0.2000"  # 20% 할인

    online_cell = next(c for c in cells if c["row_label"] == "가상몰")
    assert online_cell["column_label"] == "와인"
    assert online_cell["value"] == "0.1000"  # 10% 할인


def test_열_축을_지정하지_않으면_1차원_묶음이다(api_client: TestClient, prefix: str) -> None:
    mart = _seed_vendor(api_client, prefix, name="가상마트")
    product = _seed_product(api_client, prefix, name="위스키A")
    _add_purchase(api_client, prefix, sku_id=product["skus"][0]["id"], vendor_id=mart, quantity=3)

    response = api_client.post(
        f"{prefix}/stats/pivot", json={"row_dimension": "vendor", "metric": "bottle_count"}
    )
    assert response.status_code == 200, response.text
    cells = response.json()
    assert len(cells) == 1
    assert cells[0]["row_label"] == "가상마트"
    assert cells[0]["column_key"] is None
    assert cells[0]["column_label"] == ""
    assert cells[0]["value"] == "3"


def test_구매처가_없는_구매는_미상으로_묶인다(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="위스키A")
    _add_purchase(api_client, prefix, sku_id=product["skus"][0]["id"])

    response = api_client.post(
        f"{prefix}/stats/pivot", json={"row_dimension": "vendor", "metric": "bottle_count"}
    )
    cells = response.json()
    assert cells[0]["row_key"] is None
    assert cells[0]["row_label"] == "미상"


def test_빈티지_10년_단위로_묶는다(api_client: TestClient, prefix: str) -> None:
    p1 = _seed_product(api_client, prefix, name="와인2015", vintage=2015)
    _add_purchase(api_client, prefix, sku_id=p1["skus"][0]["id"])
    p2 = _seed_product(api_client, prefix, name="와인2019", vintage=2019)
    _add_purchase(api_client, prefix, sku_id=p2["skus"][0]["id"])
    p3 = _seed_product(api_client, prefix, name="와인2021", vintage=2021)
    _add_purchase(api_client, prefix, sku_id=p3["skus"][0]["id"])

    response = api_client.post(
        f"{prefix}/stats/pivot", json={"row_dimension": "vintage_decade", "metric": "bottle_count"}
    )
    cells = {c["row_label"]: c["value"] for c in response.json()}
    assert cells["2010년대"] == "2"
    assert cells["2020년대"] == "1"


def test_카테고리_필터는_하위_주종을_포함한다(api_client: TestClient, prefix: str) -> None:
    parent_response = api_client.post(f"{prefix}/categories", json={"name": "양주"})
    parent_id = parent_response.json()["id"]
    child_response = api_client.post(
        f"{prefix}/categories", json={"name": "위스키", "parent_id": parent_id}
    )
    child_id = child_response.json()["id"]
    other_id = _seed_category(api_client, prefix, name="와인")

    p1 = _seed_product(api_client, prefix, name="위스키A", category_id=child_id)
    _add_purchase(api_client, prefix, sku_id=p1["skus"][0]["id"], quantity=2)
    p2 = _seed_product(api_client, prefix, name="와인A", category_id=other_id)
    _add_purchase(api_client, prefix, sku_id=p2["skus"][0]["id"], quantity=5)

    response = api_client.post(
        f"{prefix}/stats/pivot",
        json={"row_dimension": "category", "metric": "bottle_count", "category_id": parent_id},
    )
    cells = response.json()
    assert len(cells) == 1
    assert cells[0]["value"] == "2"


def test_value_for_money_지표(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="가성비A", rating="6.0")
    _add_purchase(
        api_client,
        prefix,
        sku_id=product["skus"][0]["id"],
        unit_list_price="10000",
    )

    response = api_client.post(
        f"{prefix}/stats/pivot",
        json={"row_dimension": "category", "metric": "value_for_money"},
    )
    cells = response.json()
    assert cells[0]["value"] is not None


def test_avg_price_per_100ml_과_avg_rating_지표(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="국가별A", country="스코틀랜드", rating="4.0")
    _add_purchase(
        api_client,
        prefix,
        sku_id=product["skus"][0]["id"],
        unit_list_price="70000",  # 700ml -> 10,000원/100ml
    )

    price_response = api_client.post(
        f"{prefix}/stats/pivot",
        json={"row_dimension": "country", "metric": "avg_price_per_100ml"},
    )
    price_cells = price_response.json()
    assert price_cells[0]["row_label"] == "스코틀랜드"
    assert price_cells[0]["value"] == "10000.00"

    rating_response = api_client.post(
        f"{prefix}/stats/pivot",
        json={"row_dimension": "country", "metric": "avg_rating"},
    )
    rating_cells = rating_response.json()
    assert rating_cells[0]["value"] == "4.0000"


def test_구매처_필터와_기간_필터(api_client: TestClient, prefix: str) -> None:
    mart = _seed_vendor(api_client, prefix, name="필터마트")
    other = _seed_vendor(api_client, prefix, name="다른곳")

    p1 = _seed_product(api_client, prefix, name="필터술1")
    _add_purchase(
        api_client,
        prefix,
        sku_id=p1["skus"][0]["id"],
        vendor_id=mart,
        purchased_on="2026-03-01",
        quantity=2,
    )
    p2 = _seed_product(api_client, prefix, name="필터술2")
    _add_purchase(
        api_client,
        prefix,
        sku_id=p2["skus"][0]["id"],
        vendor_id=other,
        purchased_on="2026-03-01",
        quantity=9,
    )
    p3 = _seed_product(api_client, prefix, name="필터술3")
    _add_purchase(
        api_client,
        prefix,
        sku_id=p3["skus"][0]["id"],
        vendor_id=mart,
        purchased_on="2026-01-01",
        quantity=7,
    )

    response = api_client.post(
        f"{prefix}/stats/pivot",
        json={
            "row_dimension": "vendor",
            "metric": "bottle_count",
            "vendor_id": mart,
            "purchased_on_min": "2026-02-01",
            "purchased_on_max": "2026-03-31",
        },
    )
    cells = response.json()
    assert len(cells) == 1
    assert cells[0]["row_label"] == "필터마트"
    assert cells[0]["value"] == "2"


# --- 시계열 -------------------------------------------------------------------


def test_월별_지출과_병수를_묶는다(api_client: TestClient, prefix: str) -> None:
    p1 = _seed_product(api_client, prefix, name="1월술")
    _add_purchase(
        api_client,
        prefix,
        sku_id=p1["skus"][0]["id"],
        purchased_on="2026-01-15",
        unit_paid_price="10000",
    )
    p2 = _seed_product(api_client, prefix, name="1월술2")
    _add_purchase(
        api_client,
        prefix,
        sku_id=p2["skus"][0]["id"],
        purchased_on="2026-01-20",
        unit_paid_price="20000",
    )
    p3 = _seed_product(api_client, prefix, name="2월술")
    _add_purchase(
        api_client,
        prefix,
        sku_id=p3["skus"][0]["id"],
        purchased_on="2026-02-01",
        unit_paid_price="5000",
    )

    response = api_client.get(f"{prefix}/stats/timeseries")
    assert response.status_code == 200, response.text
    points = {p["month"]: p for p in response.json()}
    assert points["2026-01"]["bottle_count"] == 2
    assert points["2026-01"]["paid_total"] == "30000.00"
    assert points["2026-02"]["bottle_count"] == 1


def test_구매일이_없는_구매는_시계열에서_빠진다(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="구매일없음")
    _add_purchase(api_client, prefix, sku_id=product["skus"][0]["id"])

    response = api_client.get(f"{prefix}/stats/timeseries")
    assert response.json() == []


# --- 가성비 (제품 지표 노출) ---------------------------------------------------


def test_제품_지표에_가성비가_노출된다(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="가성비제품", rating="6.0")
    _add_purchase(api_client, prefix, sku_id=product["skus"][0]["id"], unit_list_price="10000")

    response = api_client.get(f"{prefix}/products/{product['id']}")
    assert response.status_code == 200, response.text
    metrics = response.json()["metrics"]
    assert metrics["value_for_money"] is not None


def test_평점이_없으면_가성비는_null(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="평점없음")
    _add_purchase(api_client, prefix, sku_id=product["skus"][0]["id"], unit_list_price="10000")

    response = api_client.get(f"{prefix}/products/{product['id']}/metrics")
    assert response.json()["value_for_money"] is None
