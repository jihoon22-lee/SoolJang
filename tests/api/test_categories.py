"""카테고리 API 테스트.

주종 계층은 사용자가 자유롭게 관리하는 데이터다. 이동·순서 변경·병합·삭제 전략이 실제로
HTTP 로 동작하는지, 그리고 불변식이 API 경계에서 지켜지는지 확인한다.
"""

from typing import Any

from fastapi.testclient import TestClient


def _create(client: TestClient, prefix: str, name: str, parent_id: str | None = None) -> Any:
    response = client.post(f"{prefix}/categories", json={"name": name, "parent_id": parent_id})
    assert response.status_code == 201, response.text
    return response.json()


def _tree(client: TestClient, prefix: str) -> dict[str, Any]:
    response = client.get(f"{prefix}/categories")
    assert response.status_code == 200, response.text
    return response.json()


def _by_name(tree: dict[str, Any], name: str) -> dict[str, Any]:
    return next(item for item in tree["items"] if item["name"] == name)


def test_empty_tree_reports_depth_limit(api_client: TestClient, prefix: str) -> None:
    tree = _tree(api_client, prefix)

    assert tree["items"] == []
    assert tree["max_depth"] == 0
    # 사용자에게 상한을 알려야 어디까지 세분화할 수 있는지 판단할 수 있다.
    assert tree["depth_limit"] == 8


def test_create_nested_categories(api_client: TestClient, prefix: str) -> None:
    wine = _create(api_client, prefix, "와인")
    sweet = _create(api_client, prefix, "스위트와인", wine["id"])
    _create(api_client, prefix, "토카이와인", sweet["id"])

    tree = _tree(api_client, prefix)

    assert _by_name(tree, "토카이와인")["path"] == ["와인", "스위트와인", "토카이와인"]
    assert _by_name(tree, "토카이와인")["depth"] == 3
    assert tree["max_depth"] == 3


def test_reparent_moves_subtree(api_client: TestClient, prefix: str) -> None:
    wine = _create(api_client, prefix, "와인")
    sweet = _create(api_client, prefix, "스위트와인", wine["id"])
    _create(api_client, prefix, "토카이와인", sweet["id"])
    other = _create(api_client, prefix, "기타")

    response = api_client.post(
        f"{prefix}/categories/{sweet['id']}:reparent", json={"new_parent_id": other["id"]}
    )

    assert response.status_code == 200, response.text
    tree = response.json()
    assert _by_name(tree, "토카이와인")["path"] == ["기타", "스위트와인", "토카이와인"]


def test_reparent_to_descendant_is_rejected_with_problem_details(
    api_client: TestClient, prefix: str
) -> None:
    wine = _create(api_client, prefix, "와인")
    sweet = _create(api_client, prefix, "스위트와인", wine["id"])

    response = api_client.post(
        f"{prefix}/categories/{wine['id']}:reparent", json={"new_parent_id": sweet["id"]}
    )

    assert response.status_code == 422
    body = response.json()
    assert body["type"].endswith("/validation")
    assert "순환" in body["detail"]


def test_reparent_to_root(api_client: TestClient, prefix: str) -> None:
    wine = _create(api_client, prefix, "와인")
    sweet = _create(api_client, prefix, "스위트와인", wine["id"])

    response = api_client.post(
        f"{prefix}/categories/{sweet['id']}:reparent", json={"new_parent_id": None}
    )

    assert response.status_code == 200
    assert _by_name(response.json(), "스위트와인")["parent_id"] is None


def test_rename_updates_name(api_client: TestClient, prefix: str) -> None:
    sake = _create(api_client, prefix, "사케")

    response = api_client.patch(f"{prefix}/categories/{sake['id']}", json={"name": "니혼슈"})

    assert response.status_code == 200
    assert response.json()["name"] == "니혼슈"


def test_reorder_changes_sort_order(api_client: TestClient, prefix: str) -> None:
    first = _create(api_client, prefix, "가")
    second = _create(api_client, prefix, "나")

    response = api_client.post(
        f"{prefix}/categories:reorder",
        json={
            "items": [{"id": first["id"], "sort_order": 10}, {"id": second["id"], "sort_order": 5}]
        },
    )

    assert response.status_code == 200, response.text
    tree = response.json()
    assert _by_name(tree, "가")["sort_order"] == 10
    assert _by_name(tree, "나")["sort_order"] == 5


def test_reorder_rejects_duplicate_ids(api_client: TestClient, prefix: str) -> None:
    category = _create(api_client, prefix, "가")

    response = api_client.post(
        f"{prefix}/categories:reorder",
        json={
            "items": [
                {"id": category["id"], "sort_order": 1},
                {"id": category["id"], "sort_order": 2},
            ]
        },
    )

    assert response.status_code == 422
    assert "중복" in response.json()["detail"]


def test_reset_seed_creates_default_hierarchy(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(f"{prefix}/categories:reset-seed")

    assert response.status_code == 200, response.text
    paths = {tuple(item["path"]) for item in response.json()["items"]}
    assert ("맥주",) in paths
    assert ("양주", "위스키", "싱글몰트 위스키") in paths
    assert ("미분류",) in paths


def test_reset_seed_is_idempotent(api_client: TestClient, prefix: str) -> None:
    first = api_client.post(f"{prefix}/categories:reset-seed").json()
    second = api_client.post(f"{prefix}/categories:reset-seed").json()

    assert len(first["items"]) == len(second["items"])


def test_reset_seed_preserves_user_renames(api_client: TestClient, prefix: str) -> None:
    """사용자가 바꾼 이름을 시드가 되살리면 편집을 무시하는 셈이다."""
    tree = api_client.post(f"{prefix}/categories:reset-seed").json()
    sake = _by_name(tree, "사케")
    api_client.patch(f"{prefix}/categories/{sake['id']}", json={"name": "니혼슈"})

    after = api_client.post(f"{prefix}/categories:reset-seed").json()

    names = {item["name"] for item in after["items"]}
    assert "니혼슈" in names


def test_save_as_default_then_reset_seed_restores_custom_structure(
    api_client: TestClient, prefix: str
) -> None:
    """저장해 둔 구조가 있으면 하드코딩된 앱 기본값 대신 그 구조로 복원해야 한다."""
    custom_root = _create(api_client, prefix, "커스텀주")
    _create(api_client, prefix, "커스텀주 하위", custom_root["id"])

    saved = api_client.post(f"{prefix}/categories:save-as-default").json()
    # 저장 자체는 현재 계층을 바꾸지 않는다.
    assert {item["name"] for item in saved["items"]} == {"커스텀주", "커스텀주 하위"}

    delete_response = api_client.delete(
        f"{prefix}/categories/{custom_root['id']}", params={"strategy": "promote_children"}
    )
    assert delete_response.status_code == 200
    names_after_delete = {item["name"] for item in delete_response.json()["items"]}
    assert "커스텀주" not in names_after_delete

    restored = api_client.post(f"{prefix}/categories:reset-seed").json()
    names = {item["name"] for item in restored["items"]}
    assert "커스텀주" in names
    assert "커스텀주 하위" in names
    # 하드코딩된 앱 기본값(예: "맥주")은 저장된 구조에 없으므로 되살아나지 않는다.
    assert "맥주" not in names


def test_save_as_default_with_empty_tree_makes_reset_seed_noop(
    api_client: TestClient, prefix: str
) -> None:
    """빈 트리를 저장했다면, 그것도 사용자의 의도다 — 앱 기본값으로 몰래 되돌아가면 안 된다."""
    api_client.post(f"{prefix}/categories:save-as-default")

    restored = api_client.post(f"{prefix}/categories:reset-seed").json()

    assert restored["items"] == []


def test_save_as_default_is_idempotent_and_updates_in_place(
    api_client: TestClient, prefix: str
) -> None:
    """다시 저장하면 이전 저장을 대체한다(중복 행이 쌓이지 않는다)."""
    first_root = _create(api_client, prefix, "첫 구조")
    api_client.post(f"{prefix}/categories:save-as-default")

    api_client.delete(f"{prefix}/categories/{first_root['id']}")
    second_root = _create(api_client, prefix, "두 번째 구조")
    api_client.post(f"{prefix}/categories:save-as-default")

    api_client.delete(f"{prefix}/categories/{second_root['id']}")
    restored = api_client.post(f"{prefix}/categories:reset-seed").json()

    names = {item["name"] for item in restored["items"]}
    assert "두 번째 구조" in names
    assert "첫 구조" not in names


def test_delete_empty_category(api_client: TestClient, prefix: str) -> None:
    category = _create(api_client, prefix, "삭제 대상")

    response = api_client.delete(f"{prefix}/categories/{category['id']}")

    assert response.status_code == 200
    assert all(item["name"] != "삭제 대상" for item in response.json()["items"])


def test_delete_with_children_is_rejected_by_default(api_client: TestClient, prefix: str) -> None:
    """개인 기록을 잃는 것이 가장 큰 손실이므로 기본은 거부다."""
    parent = _create(api_client, prefix, "부모")
    _create(api_client, prefix, "자식", parent["id"])

    response = api_client.delete(f"{prefix}/categories/{parent['id']}")

    assert response.status_code == 409
    body = response.json()
    assert body["type"].endswith("/conflict")
    assert "하위 카테고리" in body["detail"]


def test_delete_with_promote_children_lifts_them(api_client: TestClient, prefix: str) -> None:
    grandparent = _create(api_client, prefix, "조부모")
    parent = _create(api_client, prefix, "부모", grandparent["id"])
    _create(api_client, prefix, "자식", parent["id"])

    response = api_client.delete(
        f"{prefix}/categories/{parent['id']}", params={"strategy": "promote_children"}
    )

    assert response.status_code == 200, response.text
    tree = response.json()
    assert _by_name(tree, "자식")["path"] == ["조부모", "자식"]


def test_delete_with_products_requires_reassign(api_client: TestClient, prefix: str) -> None:
    category = _create(api_client, prefix, "제품 있는 주종")
    api_client.post(f"{prefix}/products", json={"name": "테스트 술", "category_id": category["id"]})

    rejected = api_client.delete(f"{prefix}/categories/{category['id']}")
    assert rejected.status_code == 409
    assert "소속 제품" in rejected.json()["detail"]

    target = _create(api_client, prefix, "옮길 주종")
    accepted = api_client.delete(
        f"{prefix}/categories/{category['id']}",
        params={"strategy": "reassign", "target_id": target["id"]},
    )
    assert accepted.status_code == 200, accepted.text
    assert _by_name(accepted.json(), "옮길 주종")["product_count"] == 1


def test_delete_reassign_without_target_is_rejected(api_client: TestClient, prefix: str) -> None:
    category = _create(api_client, prefix, "주종")

    response = api_client.delete(
        f"{prefix}/categories/{category['id']}", params={"strategy": "reassign"}
    )

    assert response.status_code == 422
    assert "target_id" in response.json()["detail"]


def test_merge_moves_products_and_children(api_client: TestClient, prefix: str) -> None:
    source = _create(api_client, prefix, "중복 주종")
    _create(api_client, prefix, "하위", source["id"])
    target = _create(api_client, prefix, "정식 주종")
    api_client.post(f"{prefix}/products", json={"name": "옮겨질 술", "category_id": source["id"]})

    response = api_client.post(
        f"{prefix}/categories/{source['id']}:merge", json={"target_id": target["id"]}
    )

    assert response.status_code == 200, response.text
    tree = response.json()
    assert all(item["name"] != "중복 주종" for item in tree["items"])
    assert _by_name(tree, "하위")["path"] == ["정식 주종", "하위"]
    assert _by_name(tree, "정식 주종")["product_count"] == 1


def test_merge_into_descendant_is_rejected(api_client: TestClient, prefix: str) -> None:
    parent = _create(api_client, prefix, "부모")
    child = _create(api_client, prefix, "자식", parent["id"])

    response = api_client.post(
        f"{prefix}/categories/{parent['id']}:merge", json={"target_id": child["id"]}
    )

    assert response.status_code == 422
    assert "순환" in response.json()["detail"]


def test_descendant_product_count_rolls_up(api_client: TestClient, prefix: str) -> None:
    """필터가 하위를 포함하므로 배지 숫자도 롤업이 맞다."""
    whisky = _create(api_client, prefix, "위스키")
    single_malt = _create(api_client, prefix, "싱글몰트", whisky["id"])
    api_client.post(f"{prefix}/products", json={"name": "술 1", "category_id": single_malt["id"]})
    api_client.post(f"{prefix}/products", json={"name": "술 2", "category_id": whisky["id"]})

    tree = _tree(api_client, prefix)

    assert _by_name(tree, "위스키")["product_count"] == 1
    assert _by_name(tree, "위스키")["descendant_product_count"] == 2
    assert _by_name(tree, "싱글몰트")["descendant_product_count"] == 1


def test_unknown_category_returns_not_found(api_client: TestClient, prefix: str) -> None:
    missing = "00000000-0000-0000-0000-0000000000ff"

    response = api_client.patch(f"{prefix}/categories/{missing}", json={"name": "x"})

    assert response.status_code == 404
    assert response.json()["type"].endswith("/not-found")
