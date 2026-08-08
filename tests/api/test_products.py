"""제품 API 테스트."""

from typing import Any

from fastapi.testclient import TestClient


def _post(client: TestClient, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = client.post(path, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _seed_product(
    client: TestClient,
    prefix: str,
    *,
    name: str,
    abv: str | None = None,
    vintage: int | None = None,
    rating: str | None = None,
    country: str | None = None,
    varieties: list[str] | None = None,
    volume_ml: int | None = 700,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": name}
    if abv is not None:
        payload["abv"] = abv
    if vintage is not None:
        payload["vintage"] = vintage
    if rating is not None:
        payload["personal_rating"] = rating
    if country is not None:
        payload["country"] = country
    if varieties is not None:
        payload["variety_names"] = varieties
    if volume_ml is not None:
        payload["skus"] = [{"volume_ml": volume_ml}]
    return _post(client, f"{prefix}/products", payload)


def _list(client: TestClient, prefix: str, **params: Any) -> dict[str, Any]:
    response = client.get(f"{prefix}/products", params=params)
    assert response.status_code == 200, response.text
    return response.json()


# --- 생성·조회 ---------------------------------------------------------------


def test_create_product_with_skus_and_varieties(api_client: TestClient, prefix: str) -> None:
    """4계층 입력 부담을 줄이려면 한 요청으로 제품·규격·품종을 만들 수 있어야 한다."""
    created = _seed_product(
        api_client,
        prefix,
        name="가상 증류소 싱글몰트 12y",
        abv="46.0",
        varieties=["Trappist Ale", "Quadrupel"],
    )

    assert created["name"] == "가상 증류소 싱글몰트 12y"
    assert len(created["skus"]) == 1
    assert created["skus"][0]["volume_ml"] == 700
    assert created["varieties"] == ["Trappist Ale", "Quadrupel"]
    # 구매 건이 없으면 금액은 null 이고 병수는 0 이다.
    assert created["metrics"]["purchased_count"] == 0
    assert created["metrics"]["avg_list_price"] is None


def test_variety_typo_is_normalized_on_create(api_client: TestClient, prefix: str) -> None:
    created = _seed_product(api_client, prefix, name="가상 와인", varieties=["Carbernet Sauvignon"])

    assert created["varieties"] == ["Cabernet Sauvignon"]


def test_get_product_detail(api_client: TestClient, prefix: str) -> None:
    created = _seed_product(api_client, prefix, name="상세 조회 대상")

    response = api_client.get(f"{prefix}/products/{created['id']}")

    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


def test_product_out_includes_created_and_updated_at(api_client: TestClient, prefix: str) -> None:
    """오프라인 Dexie 미러(`SyncRow`)는 이 값들을 이미 갖고 있었는데 온라인 응답에만
    빠져 있었다 — 프론트 "등록일" 정렬 선택지가 실제로는 아무 효과가 없던 원인이다."""
    created = _seed_product(api_client, prefix, name="생성 시각 확인 대상")

    body = api_client.get(f"{prefix}/products/{created['id']}").json()

    assert body["created_at"] is not None
    assert body["updated_at"] is not None


def test_unknown_product_returns_problem_details(api_client: TestClient, prefix: str) -> None:
    response = api_client.get(f"{prefix}/products/00000000-0000-0000-0000-0000000000ff")

    assert response.status_code == 404
    body = response.json()
    assert body["type"].endswith("/not-found")
    assert body["status"] == 404
    assert body["instance"].endswith("0000000000ff")


def test_category_path_is_included(api_client: TestClient, prefix: str) -> None:
    tree = api_client.post(f"{prefix}/categories:reset-seed").json()
    single_malt = next(
        item for item in tree["items"] if item["path"] == ["양주", "위스키", "싱글몰트 위스키"]
    )
    created = _post(
        api_client,
        f"{prefix}/products",
        {"name": "계층 확인용", "category_id": single_malt["id"]},
    )

    assert created["category_path"] == ["양주", "위스키", "싱글몰트 위스키"]


def test_create_with_unknown_category_returns_not_found(
    api_client: TestClient, prefix: str
) -> None:
    response = api_client.post(
        f"{prefix}/products",
        json={"name": "x", "category_id": "00000000-0000-0000-0000-0000000000ff"},
    )

    assert response.status_code == 404


def test_update_product_replaces_varieties(api_client: TestClient, prefix: str) -> None:
    created = _seed_product(api_client, prefix, name="수정 대상", varieties=["Lager"])

    response = api_client.patch(
        f"{prefix}/products/{created['id']}",
        json={"personal_rating": "5.5", "variety_names": ["IPA", "Pale Ale"]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["personal_rating"] == "5.5"
    assert body["varieties"] == ["IPA", "Pale Ale"]


def test_removed_variety_disappears_from_detail_immediately(
    api_client: TestClient, prefix: str
) -> None:
    """뺀 품종은 다음 조회에서 바로 안 보여야 한다(내부적으로 소프트 삭제되므로)."""
    created = _seed_product(api_client, prefix, name="품종 제거", varieties=["레드", "스위트"])

    response = api_client.patch(
        f"{prefix}/products/{created['id']}", json={"variety_names": ["레드"]}
    )

    assert response.json()["varieties"] == ["레드"]
    assert api_client.get(f"{prefix}/products/{created['id']}").json()["varieties"] == ["레드"]


def test_soft_deleted_product_disappears_from_list(api_client: TestClient, prefix: str) -> None:
    created = _seed_product(api_client, prefix, name="삭제될 술")

    assert api_client.delete(f"{prefix}/products/{created['id']}").status_code == 204
    assert _list(api_client, prefix)["items"] == []
    assert api_client.get(f"{prefix}/products/{created['id']}").status_code == 404


def test_invalid_rating_returns_field_error(api_client: TestClient, prefix: str) -> None:
    """레거시는 6점 만점이다. 범위를 벗어나면 어느 필드가 문제인지 알려야 한다."""
    response = api_client.post(
        f"{prefix}/products", json={"name": "평점 초과", "personal_rating": "7"}
    )

    assert response.status_code == 422
    body = response.json()
    assert body["type"].endswith("/validation")
    assert any(error["field"] == "personal_rating" for error in body["errors"])


# --- 검색·필터 ---------------------------------------------------------------


def test_korean_partial_search(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="글렌알라키 캐스크 스트렝스")
    _seed_product(api_client, prefix, name="부나하벤 캐스크 스트렝스")
    _seed_product(api_client, prefix, name="가상 라거 맥주")

    result = _list(api_client, prefix, q="캐스크 스트렝스")

    assert len(result["items"]) == 2


def test_filter_by_abv_range(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="저도수", abv="5.0")
    _seed_product(api_client, prefix, name="고도수", abv="58.7")

    result = _list(api_client, prefix, abv_min="40")

    assert [item["name"] for item in result["items"]] == ["고도수"]


def test_filter_by_vintage_range(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="구 빈티지", vintage=2008)
    _seed_product(api_client, prefix, name="신 빈티지", vintage=2019)

    result = _list(api_client, prefix, vintage_min=2015)

    assert [item["name"] for item in result["items"]] == ["신 빈티지"]


def test_filter_by_rating(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="낮은 평점", rating="2.0")
    _seed_product(api_client, prefix, name="높은 평점", rating="5.5")

    result = _list(api_client, prefix, rating_min="4")

    assert [item["name"] for item in result["items"]] == ["높은 평점"]


def test_filter_by_country(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="스코틀랜드 술", country="스코틀랜드")
    _seed_product(api_client, prefix, name="일본 술", country="일본")

    result = _list(api_client, prefix, country="일본")

    assert [item["name"] for item in result["items"]] == ["일본 술"]


def test_filter_by_variety(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="라거 맥주", varieties=["Lager"])
    _seed_product(api_client, prefix, name="IPA 맥주", varieties=["IPA"])

    result = _list(api_client, prefix, variety="IPA")

    assert [item["name"] for item in result["items"]] == ["IPA 맥주"]


def test_category_filter_includes_descendants(api_client: TestClient, prefix: str) -> None:
    """`위스키` 필터가 하위 3종을 모두 포함해야 한다."""
    tree = api_client.post(f"{prefix}/categories:reset-seed").json()
    whisky = next(item for item in tree["items"] if item["path"] == ["양주", "위스키"])
    single_malt = next(
        item for item in tree["items"] if item["path"] == ["양주", "위스키", "싱글몰트 위스키"]
    )
    beer = next(item for item in tree["items"] if item["path"] == ["맥주"])

    _post(
        api_client, f"{prefix}/products", {"name": "싱글몰트 술", "category_id": single_malt["id"]}
    )
    _post(api_client, f"{prefix}/products", {"name": "맥주 하나", "category_id": beer["id"]})

    included = _list(api_client, prefix, category_id=whisky["id"])
    excluded = _list(api_client, prefix, category_id=whisky["id"], include_descendants=False)

    assert [item["name"] for item in included["items"]] == ["싱글몰트 술"]
    assert excluded["items"] == []


def test_filters_combine_with_and(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="조건 둘 다", abv="46.0", rating="5.0")
    _seed_product(api_client, prefix, name="도수만", abv="46.0", rating="2.0")

    result = _list(api_client, prefix, abv_min="40", rating_min="4")

    assert [item["name"] for item in result["items"]] == ["조건 둘 다"]


# --- 정렬·페이지네이션 --------------------------------------------------------


def test_sort_by_name_ascending_and_descending(api_client: TestClient, prefix: str) -> None:
    for name in ("다", "가", "나"):
        _seed_product(api_client, prefix, name=name)

    ascending = _list(api_client, prefix, sort="name", order="asc")
    descending = _list(api_client, prefix, sort="name", order="desc")

    assert [item["name"] for item in ascending["items"]] == ["가", "나", "다"]
    assert [item["name"] for item in descending["items"]] == ["다", "나", "가"]


def test_cursor_pagination_covers_all_items_without_duplicates(
    api_client: TestClient, prefix: str
) -> None:
    """offset 방식과 달리 중복·누락이 없어야 한다."""
    expected = [f"술 {index:02d}" for index in range(1, 8)]
    for name in expected:
        _seed_product(api_client, prefix, name=name)

    collected: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        params: dict[str, Any] = {"limit": 3, "sort": "name"}
        if cursor:
            params["cursor"] = cursor
        page = _list(api_client, prefix, **params)
        collected.extend(item["name"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert collected == expected
    assert len(collected) == len(set(collected))


def test_pagination_with_null_sort_values_loses_nothing(
    api_client: TestClient, prefix: str
) -> None:
    """정렬키에 NULL 이 섞여도 모든 항목이 나와야 한다.

    NULL 비교는 항상 거짓이라 커서 조건에 그대로 넣으면 나머지 페이지가 조용히 사라진다.
    도수·평점처럼 결측이 흔한 필드로 정렬할 때 실제로 발생하는 문제다. 레거시에 도수 결측
    26건, 평점 결측 114건이 있다.
    """
    _seed_product(api_client, prefix, name="도수 있음 1", abv="40.0")
    _seed_product(api_client, prefix, name="도수 있음 2", abv="46.0")
    _seed_product(api_client, prefix, name="도수 없음 1")
    _seed_product(api_client, prefix, name="도수 없음 2")

    collected: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        params: dict[str, Any] = {"limit": 1, "sort": "abv", "order": "asc"}
        if cursor:
            params["cursor"] = cursor
        page = _list(api_client, prefix, **params)
        collected.extend(item["name"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert sorted(collected) == [
        "도수 없음 1",
        "도수 없음 2",
        "도수 있음 1",
        "도수 있음 2",
    ]
    assert len(collected) == len(set(collected))


def test_pagination_with_null_sort_values_loses_nothing_descending(
    api_client: TestClient, prefix: str
) -> None:
    """위 오름차순 테스트의 내림차순 짝.

    `apply_cursor` 의 내림차순 분기엔 오름차순과 달리 `sort_column.is_(None)` 이
    없었다 — 커서가 NULL 아닌 값을 가리키게 되는 순간(2페이지부터)부터 NULL 정렬키
    행이 경계 조건에 안 걸려 전부 조용히 사라지는 결함이었다."""
    _seed_product(api_client, prefix, name="도수 있음 1", abv="40.0")
    _seed_product(api_client, prefix, name="도수 있음 2", abv="46.0")
    _seed_product(api_client, prefix, name="도수 없음 1")
    _seed_product(api_client, prefix, name="도수 없음 2")

    collected: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        params: dict[str, Any] = {"limit": 1, "sort": "abv", "order": "desc"}
        if cursor:
            params["cursor"] = cursor
        page = _list(api_client, prefix, **params)
        collected.extend(item["name"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert sorted(collected) == [
        "도수 없음 1",
        "도수 없음 2",
        "도수 있음 1",
        "도수 있음 2",
    ]
    assert len(collected) == len(set(collected))


def test_null_sort_values_come_last_in_ascending_order(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="값 없음")
    _seed_product(api_client, prefix, name="값 있음", abv="40.0")

    page = _list(api_client, prefix, sort="abv", order="asc", limit=10)

    assert [item["name"] for item in page["items"]] == ["값 있음", "값 없음"]


def test_last_page_has_null_cursor(api_client: TestClient, prefix: str) -> None:
    _seed_product(api_client, prefix, name="하나뿐")

    page = _list(api_client, prefix, limit=10)

    assert page["next_cursor"] is None


def test_invalid_cursor_returns_validation_error(api_client: TestClient, prefix: str) -> None:
    response = api_client.get(f"{prefix}/products", params={"cursor": "!!!not-base64!!!"})

    assert response.status_code == 422
    assert "cursor" in response.json()["detail"]


def test_sort_by_derived_metric(api_client: TestClient, prefix: str) -> None:
    """파생 지표로도 정렬할 수 있어야 한다. 저장하지 않으므로 서브쿼리 조인으로 처리한다."""
    cheap = _seed_product(api_client, prefix, name="저렴", volume_ml=700)
    pricey = _seed_product(api_client, prefix, name="고가", volume_ml=700)
    for product, price in ((cheap, "10000"), (pricey, "500000")):
        _post(
            api_client,
            f"{prefix}/purchases",
            {
                "sku_id": product["skus"][0]["id"],
                "quantity": 1,
                "unit_list_price": price,
                "unit_paid_price": price,
            },
        )

    result = _list(api_client, prefix, sort="price_per_100ml", order="asc")

    assert [item["name"] for item in result["items"]] == ["저렴", "고가"]


def test_products_without_purchases_remain_in_list(api_client: TestClient, prefix: str) -> None:
    """등록만 하고 구매 기록이 없는 술이 사라지면 데이터가 없어진 것으로 오해한다."""
    _seed_product(api_client, prefix, name="구매 기록 없음")

    result = _list(api_client, prefix)

    assert [item["name"] for item in result["items"]] == ["구매 기록 없음"]
    assert result["items"][0]["metrics"]["purchased_count"] == 0


# --- 파생 지표 노출 -----------------------------------------------------------


def test_metrics_endpoint_reflects_purchases(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="지표 확인", volume_ml=750)
    _post(
        api_client,
        f"{prefix}/purchases",
        {
            "sku_id": product["skus"][0]["id"],
            "quantity": 1,
            "unit_list_price": "23980",
            "unit_paid_price": "23980",
        },
    )

    response = api_client.get(f"{prefix}/products/{product['id']}/metrics")

    assert response.status_code == 200, response.text
    metrics = response.json()
    assert metrics["purchased_count"] == 1
    assert metrics["in_stock_count"] == 1
    # 레거시 실측 케이스: 750ml 23,980원 → 100ml당 3,197.33원
    assert metrics["price_per_100ml"].startswith("3197.3")


def test_in_stock_filter_uses_bottle_status(api_client: TestClient, prefix: str) -> None:
    with_stock = _seed_product(api_client, prefix, name="재고 있음")
    _seed_product(api_client, prefix, name="재고 없음")
    _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": with_stock["skus"][0]["id"], "quantity": 2},
    )

    result = _list(api_client, prefix, in_stock=True)

    assert [item["name"] for item in result["items"]] == ["재고 있음"]


# --- 규격 수정 (바코드 학습, Task 16) -----------------------------------------


def test_patch_sku_attaches_barcode(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="바코드 학습 대상")
    sku_id = product["skus"][0]["id"]

    response = api_client.patch(f"{prefix}/skus/{sku_id}", json={"barcode": "8801234567890"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["barcode"] == "8801234567890"
    assert body["barcode_type"] == "ean13"


def test_patch_sku_normalizes_and_classifies_barcode(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="UPC-A 학습")
    sku_id = product["skus"][0]["id"]

    response = api_client.patch(f"{prefix}/skus/{sku_id}", json={"barcode": "012345678905"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["barcode"] == "0012345678905"
    assert body["barcode_type"] == "upca"


def test_patch_sku_rejects_duplicate_barcode(api_client: TestClient, prefix: str) -> None:
    first = _seed_product(api_client, prefix, name="먼저 학습")
    second = _seed_product(api_client, prefix, name="나중에 학습")
    _post(
        api_client,
        f"{prefix}/products/{first['id']}/skus",
        {"volume_ml": 500, "barcode": "8801234567890"},
    )

    response = api_client.patch(
        f"{prefix}/skus/{second['skus'][0]['id']}", json={"barcode": "8801234567890"}
    )

    assert response.status_code == 422, response.text


def test_patch_sku_rejects_invalid_barcode(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix, name="잘못된 바코드")
    sku_id = product["skus"][0]["id"]

    response = api_client.patch(f"{prefix}/skus/{sku_id}", json={"barcode": "12"})

    assert response.status_code == 422, response.text


def test_patch_sku_updates_volume_without_touching_barcode(
    api_client: TestClient, prefix: str
) -> None:
    product = _seed_product(api_client, prefix, name="용량만 수정")
    sku_id = product["skus"][0]["id"]
    api_client.patch(f"{prefix}/skus/{sku_id}", json={"barcode": "8801234567890"})

    response = api_client.patch(f"{prefix}/skus/{sku_id}", json={"volume_ml": 1000})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["volume_ml"] == 1000
    assert body["barcode"] == "8801234567890"
