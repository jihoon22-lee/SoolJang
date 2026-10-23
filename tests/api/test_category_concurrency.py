"""두 로그인 세션의 계층 변경과 주종 배정이 살아 있는 트리를 보존한다."""

import asyncio
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from sooljang.application import categories
from sooljang.infrastructure.database.models import Category
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_categories import _create, _tree
from tests.api.test_sku_usage_concurrency import _first_session_headers


def _race(
    first: Callable[[], httpx.Response],
    second: Callable[[], httpx.Response],
    held: threading.Event,
    release: threading.Event,
    started: threading.Event,
) -> tuple[httpx.Response, httpx.Response]:
    """첫 검증 뒤에 두 번째 요청을 진입시킨다. 첫 transaction은 마지막에만 풀어 준다."""
    completed = threading.Event()

    def run_second() -> httpx.Response:
        started.set()
        try:
            return second()
        finally:
            completed.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_request = pool.submit(first)
        try:
            assert held.wait(5)
            second_request = pool.submit(run_second)
            assert started.wait(5)
            # 잠금이 없던 구현에서는 뒤 요청이 먼저 끝나 첫 검증을 무효화한다.
            # 잠금이 있으면 첫 요청을 풀기 전까지 기다린 뒤 최신 계층으로 다시 검증한다.
            completed.wait(0.5)
        finally:
            release.set()
        return first_request.result(timeout=10), second_request.result(timeout=10)


@pytest.mark.parametrize("first_action", ["reparent", "merge"])
def test_opposite_tree_changes_do_not_create_a_cycle(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, first_action: str
) -> None:
    source = _create(api_client, prefix, "원본")
    target = _create(api_client, prefix, "대상")
    descendant = (
        _create(api_client, prefix, "원본 하위", source["id"])
        if first_action == "merge"
        else source
    )
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started = (threading.Event() for _ in range(3))
    original_height = categories._subtree_height

    async def pause_first_height(session: Any, category_id: uuid.UUID) -> int:
        height = await original_height(session, category_id)
        if str(category_id) == source["id"] and not held.is_set():
            held.set()
            assert await asyncio.to_thread(release.wait, 5)
        return height

    monkeypatch.setattr(categories, "_subtree_height", pause_first_height)
    first, second = _race(
        lambda: api_client.post(
            f"{prefix}/categories/{source['id']}:{first_action}",
            json={"new_parent_id" if first_action == "reparent" else "target_id": target["id"]},
            headers=first_headers,
        ),
        lambda: api_client.post(
            f"{prefix}/categories/{target['id']}:reparent",
            json={"new_parent_id": descendant["id"]},
        ),
        held,
        release,
        started,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 422, second.text
    tree = _tree(api_client, prefix)
    nodes = {row["id"]: row for row in tree["items"]}
    assert set(nodes) == {target["id"], descendant["id"]}
    assert nodes[target["id"]]["parent_id"] is None
    assert nodes[descendant["id"]]["parent_id"] == target["id"]


@pytest.mark.parametrize("via_sync", [False, True])
def test_parent_deletion_prevents_concurrent_child_creation(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, via_sync: bool
) -> None:
    parent = _create(api_client, prefix, "삭제할 부모")
    owner = api_client.get(f"{prefix}/auth/me").json()["id"]
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started = (threading.Event() for _ in range(3))
    original_products = categories._products_in

    async def pause_after_empty_check(session: Any, category_id: uuid.UUID) -> Any:
        rows = await original_products(session, category_id)
        if str(category_id) == parent["id"] and not held.is_set():
            held.set()
            assert await asyncio.to_thread(release.wait, 5)
        return rows

    monkeypatch.setattr(categories, "_products_in", pause_after_empty_check)
    request_id = str(uuid.uuid4())
    child_id = str(uuid.uuid4())
    sync_payload = {
        "expected_user_id": owner,
        "operations": [
            {
                "idempotency_key": request_id,
                "entity": "category",
                "entity_id": child_id,
                "op": "create",
                "fields": {"name": "늦은 자식", "parent_id": parent["id"]},
            }
        ],
    }
    first, second = _race(
        lambda: api_client.delete(f"{prefix}/categories/{parent['id']}", headers=first_headers),
        lambda: (
            api_client.post(f"{prefix}/sync/batch", json=sync_payload)
            if via_sync
            else api_client.post(
                f"{prefix}/categories", json={"name": "늦은 자식", "parent_id": parent["id"]}
            )
        ),
        held,
        release,
        started,
    )

    assert first.status_code == 200, first.text
    if via_sync:
        assert second.status_code == 200, second.text
        assert second.json()["results"][0]["status"] == "failed", second.text
        replay = api_client.post(f"{prefix}/sync/batch", json=sync_payload)
        assert replay.json() == second.json()
    else:
        assert second.status_code == 404, second.text
    assert _tree(api_client, prefix)["items"] == []

    async def no_hidden_children() -> None:
        async with get_session_factory()() as session:
            assert await categories._child_ids(session, uuid.UUID(parent["id"])) == []

    assert api_client.portal is not None
    api_client.portal.call(no_hidden_children)


@pytest.mark.parametrize("assignment", ["create", "update", "sync", "cleanup"])
def test_category_deletion_prevents_concurrent_product_assignment(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, assignment: str
) -> None:
    category = _create(api_client, prefix, "삭제할 주종")
    product = api_client.post(f"{prefix}/products", json={"name": "주종 없는 제품"}).json()
    owner = api_client.get(f"{prefix}/auth/me").json()["id"]
    preview = api_client.post(
        f"{prefix}/collection/cleanup/preview",
        json={"kind": "product_category", "ids": [product["id"]], "target_id": category["id"]},
    ).json()
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started = (threading.Event() for _ in range(3))
    original_products = categories._products_in

    async def pause_after_empty_check(session: Any, category_id: uuid.UUID) -> Any:
        rows = await original_products(session, category_id)
        if str(category_id) == category["id"] and not held.is_set():
            held.set()
            assert await asyncio.to_thread(release.wait, 5)
        return rows

    def assign() -> httpx.Response:
        if assignment == "create":
            return api_client.post(
                f"{prefix}/products", json={"name": "새 제품", "category_id": category["id"]}
            )
        if assignment == "update":
            return api_client.patch(
                f"{prefix}/products/{product['id']}", json={"category_id": category["id"]}
            )
        if assignment == "cleanup":
            return api_client.post(f"{prefix}/collection/cleanup/{preview['id']}/confirm")
        return api_client.post(
            f"{prefix}/sync/batch",
            json={
                "expected_user_id": owner,
                "operations": [
                    {
                        "idempotency_key": str(uuid.uuid4()),
                        "entity": "product",
                        "entity_id": product["id"],
                        "op": "update",
                        "fields": {"category_id": category["id"]},
                    }
                ],
            },
        )

    monkeypatch.setattr(categories, "_products_in", pause_after_empty_check)
    first, second = _race(
        lambda: api_client.delete(f"{prefix}/categories/{category['id']}", headers=first_headers),
        assign,
        held,
        release,
        started,
    )

    assert first.status_code == 200, first.text
    if assignment == "sync":
        assert second.status_code == 200, second.text
        assert second.json()["results"][0]["status"] == "failed", second.text
    else:
        assert second.status_code == 404, second.text
    products = api_client.get(f"{prefix}/products").json()["items"]
    assert len(products) == 1
    assert products[0]["id"] == product["id"]
    assert products[0]["category_id"] is None


def test_waiting_writer_does_not_reuse_a_cached_deleted_parent(
    api_client: TestClient, prefix: str
) -> None:
    parent = _create(api_client, prefix, "이전 조회의 부모")
    child = _create(api_client, prefix, "옮길 주종")
    user_id = uuid.UUID(api_client.get(f"{prefix}/auth/me").json()["id"])

    async def use_old_identity_map() -> str | None:
        factory = get_session_factory()
        async with factory() as waiting:
            cached = await waiting.get(Category, uuid.UUID(parent["id"]))
            assert cached is not None and cached.deleted_at is None
            async with factory.begin() as deleting:
                await categories.delete_category(deleting, user_id=user_id, category_id=cached.id)
            try:
                await categories.reparent_category(
                    waiting,
                    user_id=user_id,
                    category_id=uuid.UUID(child["id"]),
                    new_parent_id=cached.id,
                )
            except categories.CategoryError as error:
                return str(error)
        return None

    assert api_client.portal is not None
    error = api_client.portal.call(use_old_identity_map)
    assert error is not None and "새 상위 카테고리" in error
    assert _tree(api_client, prefix)["items"][0]["parent_id"] is None


def test_concurrent_seed_restore_does_not_duplicate_root_categories(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _create(api_client, prefix, "사용자 기본 주종")
    assert api_client.post(f"{prefix}/categories:save-as-default").status_code == 200
    assert api_client.delete(f"{prefix}/categories/{root['id']}").status_code == 200
    first_headers = _first_session_headers(api_client, prefix)
    held, release, started = (threading.Event() for _ in range(3))
    original_tree = categories.load_tree

    async def pause_first_empty_tree(session: Any, user_id: uuid.UUID) -> Any:
        tree = await original_tree(session, user_id)
        if not tree and not held.is_set():
            held.set()
            assert await asyncio.to_thread(release.wait, 5)
        return tree

    monkeypatch.setattr(categories, "load_tree", pause_first_empty_tree)
    first, second = _race(
        lambda: api_client.post(f"{prefix}/categories:reset-seed", headers=first_headers),
        lambda: api_client.post(f"{prefix}/categories:reset-seed"),
        held,
        release,
        started,
    )

    assert first.status_code == second.status_code == 200
    nodes = _tree(api_client, prefix)["items"]
    assert len(nodes) == 1
    assert nodes[0]["path"] == ["사용자 기본 주종"]
    assert first.json()["items"][0]["id"] == second.json()["items"][0]["id"]
