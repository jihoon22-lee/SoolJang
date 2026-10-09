"""조회와 맥락 조합 사이에 별도 트랜잭션이 바뀌어도 삭제 자료를 노출하지 않는다."""

import datetime
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.routes import tastings
from sooljang.infrastructure.database.models import Bottle, Product, Purchase, Sku, TastingSession
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_history_corrections import _tasting
from tests.api.test_tastings import _create_product_with_bottle


@pytest.mark.parametrize("endpoint", ["page", "single"])
@pytest.mark.parametrize(
    "deleted_entity", ["bottle", "purchase", "sku", "product", "tasting", "standalone_product"]
)
def test_delete_committed_between_tasting_read_and_context_is_hidden(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
    deleted_entity: str,
) -> None:
    source = _create_product_with_bottle(api_client, prefix)
    if deleted_entity == "standalone_product":
        result = api_client.post(
            f"{prefix}/tastings", json={"sku_id": source["sku_id"], "tasted_on": "2026-01-03"}
        )
        assert result.status_code == 201
        row = result.json()
    else:
        row = _tasting(api_client, prefix, source["bottles"][0]["id"], tasted_on="2026-01-03")
    other = _create_product_with_bottle(api_client, prefix)
    older = _tasting(api_client, prefix, other["bottles"][0]["id"], tasted_on="2026-01-01")
    model, row_id = {
        "bottle": (Bottle, source["bottles"][0]["id"]),
        "purchase": (Purchase, source["purchase_id"]),
        "sku": (Sku, source["sku_id"]),
        "product": (Product, row["context"]["product_id"]),
        "tasting": (TastingSession, row["id"]),
        "standalone_product": (Product, row["context"]["product_id"]),
    }[deleted_entity]
    original_context = tastings.contextual_tastings
    changed = False

    async def delete_then_context(
        session: AsyncSession, user_id: uuid.UUID, records: list[TastingSession], **filters: Any
    ) -> list[dict[str, Any]]:
        nonlocal changed
        if not changed:
            changed = True
            # 별도 DB 세션이 처음 조회된 행의 부모 또는 시음을 삭제하고 커밋한다.
            async with get_session_factory().begin() as writer:
                deleted = await writer.get(model, uuid.UUID(row_id))
                assert deleted is not None
                deleted.deleted_at = datetime.datetime.now(datetime.UTC)
        return await original_context(session, user_id, records, **filters)

    monkeypatch.setattr(tastings, "contextual_tastings", delete_then_context)
    path = (
        f"{prefix}/tastings/{row['id']}"
        if endpoint == "single"
        else f"{prefix}/tastings/page?limit=1"
    )
    response = api_client.get(path)
    if endpoint == "single":
        assert response.status_code == 404, response.text
    else:
        assert response.status_code == 200, response.text
        assert response.json()["items"] == []
        cursor = response.json()["next_cursor"]
        assert cursor is not None
        continued = api_client.get(f"{prefix}/tastings/page", params={"limit": 1, "cursor": cursor})
        assert continued.status_code == 200
        assert [item["id"] for item in continued.json()["items"]] == [older["id"]]


@pytest.mark.parametrize("scope", ["single", "product", "sku", "bottle", "date"])
def test_context_reads_latest_connection_in_one_snapshot(
    api_client: TestClient,
    prefix: str,
    monkeypatch: pytest.MonkeyPatch,
    scope: str,
) -> None:
    source = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, source["bottles"][0]["id"])
    target = _create_product_with_bottle(api_client, prefix, volume_ml=500)
    original_context = tastings.contextual_tastings

    async def move_then_context(
        session: AsyncSession, user_id: uuid.UUID, records: list[TastingSession], **filters: Any
    ) -> list[dict[str, Any]]:
        async with get_session_factory().begin() as writer:
            moved = await writer.get(TastingSession, uuid.UUID(row["id"]))
            assert moved is not None
            moved.tasted_on = datetime.date(2026, 2, 1)
            moved.sku_id = uuid.UUID(target["sku_id"])
            moved.bottle_id = uuid.UUID(target["bottles"][0]["id"])
        return await original_context(session, user_id, records, **filters)

    monkeypatch.setattr(tastings, "contextual_tastings", move_then_context)
    query = {
        "product": {"product_id": row["context"]["product_id"]},
        "sku": {"sku_id": source["sku_id"]},
        "bottle": {"bottle_id": source["bottles"][0]["id"]},
        "date": {"tasted_on_max": "2026-01-31"},
    }
    response = (
        api_client.get(f"{prefix}/tastings/{row['id']}")
        if scope == "single"
        else api_client.get(f"{prefix}/tastings/page", params=query[scope])
    )
    assert response.status_code == 200, response.text
    if scope != "single":
        assert response.json()["items"] == []
        return
    current = response.json()
    assert current["sku_id"] == current["context"]["sku_id"] == target["sku_id"]
    assert current["bottle_id"] == current["bottle"]["id"] == target["bottles"][0]["id"]
    assert current["purchase"]["id"] == target["purchase_id"]
    assert current["context"]["volume_ml"] == 500
