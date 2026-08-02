"""병 상태 전이와 시음 API 통합 테스트."""

from typing import Any

from fastapi.testclient import TestClient


def _create_product_with_bottle(
    api_client: TestClient, prefix: str, *, volume_ml: int = 750, quantity: int = 1
) -> dict[str, Any]:
    """제품·규격·구매를 만들고 병 목록을 돌려준다."""
    category = api_client.post(f"{prefix}/categories", json={"name": "위스키"})
    assert category.status_code == 201, category.text

    product = api_client.post(
        f"{prefix}/products",
        json={
            "name": "테스트 위스키",
            "category_id": category.json()["id"],
            "abv": "46.0",
            "skus": [{"volume_ml": volume_ml}],
        },
    )
    assert product.status_code == 201, product.text
    body = product.json()
    sku_id = body["skus"][0]["id"]

    purchase = api_client.post(
        f"{prefix}/purchases",
        json={"sku_id": sku_id, "quantity": quantity, "unit_list_price": "100000"},
    )
    assert purchase.status_code == 201, purchase.text
    purchase_id = purchase.json()["id"]

    bottles = api_client.get(f"{prefix}/purchases/{purchase_id}/bottles")
    assert bottles.status_code == 200, bottles.text
    return {
        "product": body,
        "sku_id": sku_id,
        "purchase_id": purchase_id,
        "bottles": bottles.json(),
    }


class TestBottleTransitions:
    def test_개봉하면_잔량이_규격_용량이_된다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        response = api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "open"
        assert body["remaining_ml"] == 750
        assert body["opened_on"] is not None

    def test_이미_개봉한_병을_다시_개봉하면_409(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
        response = api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
        assert response.status_code == 409

    def test_소진하면_잔량이_0(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
        response = api_client.post(f"{prefix}/bottles/{bottle_id}:finish", json={})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "finished"
        assert response.json()["remaining_ml"] == 0

    def test_증여는_잔량을_보존한다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={"remaining_ml": 400})
        response = api_client.post(f"{prefix}/bottles/{bottle_id}:gift", json={"note": "친구에게"})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "gifted"
        assert response.json()["remaining_ml"] == 400

    def test_판매도_같은_경로(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        response = api_client.post(f"{prefix}/bottles/{bottle_id}:sell", json={})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "sold"

    def test_되돌리면_개봉_상태가_된다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        api_client.post(f"{prefix}/bottles/{bottle_id}:finish", json={})
        response = api_client.post(f"{prefix}/bottles/{bottle_id}:reopen")
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "open"
        assert response.json()["finished_on"] is None

    def test_개봉을_미개봉으로_되돌린다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})
        response = api_client.post(f"{prefix}/bottles/{bottle_id}:unopen")
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "unopened"
        assert response.json()["opened_on"] is None
        assert response.json()["remaining_ml"] is None

    def test_미개봉_병을_되돌리면_409(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        response = api_client.post(f"{prefix}/bottles/{bottle_id}:unopen")
        assert response.status_code == 409

    def test_없는_병은_404(self, api_client: TestClient, prefix: str) -> None:
        missing = "00000000-0000-0000-0000-0000000000ff"
        assert api_client.post(f"{prefix}/bottles/{missing}:open", json={}).status_code == 404

    def test_재고_필터가_동작한다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix, quantity=3)
        bottles = setup["bottles"]
        assert len(bottles) == 3

        api_client.post(f"{prefix}/bottles/{bottles[0]['id']}:finish", json={})

        in_stock = api_client.get(f"{prefix}/bottles", params={"in_stock": True})
        assert in_stock.status_code == 200
        assert len(in_stock.json()) == 2

        out = api_client.get(f"{prefix}/bottles", params={"in_stock": False})
        assert len(out.json()) == 1

    def test_상태로_필터한다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix, quantity=2)
        api_client.post(f"{prefix}/bottles/{setup['bottles'][0]['id']}:open", json={})

        response = api_client.get(f"{prefix}/bottles", params={"status": "open"})
        assert response.status_code == 200
        assert len(response.json()) == 1
        assert response.json()[0]["status"] == "open"


class TestTastingApi:
    def test_시음을_기록하면_잔량이_차감된다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]
        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})

        response = api_client.post(
            f"{prefix}/tastings",
            json={
                "bottle_id": bottle_id,
                "tasted_on": "2026-07-01",
                "poured_ml": 30,
                "rating": "4.5",
                "nose": "바닐라",
                "place": "집",
            },
        )
        assert response.status_code == 201, response.text
        assert response.json()["rating"] == "4.5"

        bottle = api_client.get(f"{prefix}/bottles/{bottle_id}")
        assert bottle.json()["remaining_ml"] == 720

    def test_미개봉_병에_기록하면_자동_개봉된다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]

        response = api_client.post(
            f"{prefix}/tastings",
            json={"bottle_id": bottle_id, "tasted_on": "2026-07-01", "poured_ml": 45},
        )
        assert response.status_code == 201, response.text

        bottle = api_client.get(f"{prefix}/bottles/{bottle_id}")
        assert bottle.json()["status"] == "open"
        assert bottle.json()["remaining_ml"] == 705

    def test_잔량_초과는_409(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]
        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={"remaining_ml": 50})

        response = api_client.post(
            f"{prefix}/tastings",
            json={"bottle_id": bottle_id, "tasted_on": "2026-07-01", "poured_ml": 500},
        )
        assert response.status_code == 409
        assert "잔량이 부족" in response.json()["detail"]

    def test_반점_단위가_아닌_평점은_422(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        response = api_client.post(
            f"{prefix}/tastings",
            json={
                "bottle_id": setup["bottles"][0]["id"],
                "tasted_on": "2026-07-01",
                "rating": "3.7",
            },
        )
        assert response.status_code == 422

    def test_6점을_넘는_평점은_422(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        response = api_client.post(
            f"{prefix}/tastings",
            json={
                "bottle_id": setup["bottles"][0]["id"],
                "tasted_on": "2026-07-01",
                "rating": "7.0",
            },
        )
        assert response.status_code == 422

    def test_병도_규격도_없으면_422(self, api_client: TestClient, prefix: str) -> None:
        response = api_client.post(f"{prefix}/tastings", json={"tasted_on": "2026-07-01"})
        assert response.status_code == 422

    def test_평점_추이를_요약한다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]
        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})

        for date, rating in (("2026-07-01", "3.5"), ("2026-07-15", "4.0"), ("2026-08-01", "5.0")):
            created = api_client.post(
                f"{prefix}/tastings",
                json={
                    "bottle_id": bottle_id,
                    "tasted_on": date,
                    "poured_ml": 30,
                    "rating": rating,
                },
            )
            assert created.status_code == 201, created.text

        response = api_client.get(f"{prefix}/tastings/summary", params={"bottle_id": bottle_id})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["session_count"] == 3
        assert body["first_rating"] == "3.5"
        assert body["latest_rating"] == "5.0"
        assert body["rating_change"] == "1.5"
        assert body["total_poured_ml"] == 90

    def test_기록이_없어도_404가_아니다(self, api_client: TestClient, prefix: str) -> None:
        # 아직 마시지 않은 것은 정상 상태다.
        response = api_client.get(f"{prefix}/tastings/summary")
        assert response.status_code == 200
        assert response.json()["session_count"] == 0
        assert response.json()["average_rating"] is None

    def test_타임라인은_최근_순이다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]
        api_client.post(f"{prefix}/bottles/{bottle_id}:open", json={})

        for date in ("2026-07-01", "2026-07-20", "2026-07-10"):
            api_client.post(
                f"{prefix}/tastings",
                json={"bottle_id": bottle_id, "tasted_on": date, "poured_ml": 10},
            )

        response = api_client.get(f"{prefix}/bottles/{bottle_id}/tastings")
        assert response.status_code == 200, response.text
        dates = [item["tasted_on"] for item in response.json()]
        assert dates == sorted(dates, reverse=True)

    def test_시음_기록을_삭제한다(self, api_client: TestClient, prefix: str) -> None:
        setup = _create_product_with_bottle(api_client, prefix)
        bottle_id = setup["bottles"][0]["id"]
        created = api_client.post(
            f"{prefix}/tastings",
            json={"bottle_id": bottle_id, "tasted_on": "2026-07-01", "poured_ml": 30},
        )
        tasting_id = created.json()["id"]

        assert api_client.delete(f"{prefix}/tastings/{tasting_id}").status_code == 204
        assert api_client.get(f"{prefix}/tastings").json() == []

    def test_인증_없이는_거부된다(self, anon_client: TestClient, prefix: str) -> None:
        assert anon_client.get(f"{prefix}/bottles").status_code == 401
        assert anon_client.get(f"{prefix}/tastings").status_code == 401
        assert anon_client.post(f"{prefix}/tastings", json={}).status_code == 401
