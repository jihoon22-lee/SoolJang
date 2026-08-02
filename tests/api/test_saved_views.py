"""저장된 피벗 뷰 API 테스트(Task 20)."""

from fastapi.testclient import TestClient

_DEFINITION = {"row_dimension": "vendor", "column_dimension": "category", "metric": "discount_rate"}


def test_저장뷰_엔드포인트는_인증이_필요하다(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.get(f"{prefix}/saved-views")
    assert response.status_code == 401, response.text


def test_저장하면_목록에_보인다(api_client: TestClient, prefix: str) -> None:
    create = api_client.post(
        f"{prefix}/saved-views",
        json={"name": "구매처 x 주종 할인율", "definition": _DEFINITION},
    )
    assert create.status_code == 201, create.text
    body = create.json()
    assert body["name"] == "구매처 x 주종 할인율"
    assert body["definition"] == _DEFINITION

    listed = api_client.get(f"{prefix}/saved-views").json()
    assert len(listed) == 1
    assert listed[0]["id"] == body["id"]


def test_이름과_정의를_수정한다(api_client: TestClient, prefix: str) -> None:
    created = api_client.post(
        f"{prefix}/saved-views", json={"name": "원래 이름", "definition": _DEFINITION}
    ).json()

    new_definition = {**_DEFINITION, "metric": "paid_total"}
    response = api_client.patch(
        f"{prefix}/saved-views/{created['id']}",
        json={"name": "바뀐 이름", "definition": new_definition},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "바뀐 이름"
    assert body["definition"] == new_definition


def test_이름만_수정하면_정의는_그대로다(api_client: TestClient, prefix: str) -> None:
    created = api_client.post(
        f"{prefix}/saved-views", json={"name": "원래 이름", "definition": _DEFINITION}
    ).json()

    response = api_client.patch(f"{prefix}/saved-views/{created['id']}", json={"name": "새 이름"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "새 이름"
    assert body["definition"] == _DEFINITION


def test_삭제하면_목록에서_사라진다(api_client: TestClient, prefix: str) -> None:
    created = api_client.post(
        f"{prefix}/saved-views", json={"name": "지울 뷰", "definition": _DEFINITION}
    ).json()

    delete_response = api_client.delete(f"{prefix}/saved-views/{created['id']}")
    assert delete_response.status_code == 204, delete_response.text

    listed = api_client.get(f"{prefix}/saved-views").json()
    assert listed == []


def test_존재하지_않는_뷰_수정은_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.patch(
        f"{prefix}/saved-views/00000000-0000-0000-0000-000000000000",
        json={"name": "무엇"},
    )
    assert response.status_code == 404, response.text


def test_빈_이름은_거부한다(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/saved-views", json={"name": "", "definition": _DEFINITION}
    )
    assert response.status_code == 422, response.text
