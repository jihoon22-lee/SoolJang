"""규격 변경은 구매·시음의 원본을 보존하고 미사용일 때만 허용한다."""

import datetime
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from sooljang.infrastructure.database.models import Product, Purchase, Sku, TastingSession
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_purchases import _post, _product_with_sku
from tests.api.test_sync import _batch, _op, _pull


def _attach_reference(client: TestClient, prefix: str, sku_id: str, reference: str) -> str:
    if "purchase" in reference:
        row = _post(client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 1})
        if reference == "deleted_purchase":
            assert client.delete(f"{prefix}/purchases/{row['id']}").status_code == 204
    else:
        row = _post(
            client,
            f"{prefix}/tastings",
            {"sku_id": sku_id, "tasted_on": "2026-10-01", "rating": "4"},
        )
        if reference == "deleted_tasting":
            assert client.delete(f"{prefix}/tastings/{row['id']}").status_code == 204
    return row["id"]


@pytest.mark.parametrize(
    "reference", ["purchase", "deleted_purchase", "tasting", "deleted_tasting"]
)
def test_used_sku_volume_and_delete_are_rejected_online_and_in_sync(
    api_client: TestClient, prefix: str, reference: str
) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    record_id = _attach_reference(api_client, prefix, sku_id, reference)
    before = api_client.get(f"{prefix}/products/{product['id']}").json()
    changed = api_client.patch(f"{prefix}/skus/{sku_id}", json={"volume_ml": 1000})
    assert changed.status_code == 409, changed.text
    assert api_client.delete(f"{prefix}/skus/{sku_id}").status_code == 409
    for operation, fields in [("update", {"volume_ml": 1000}), ("delete", {})]:
        result = _batch(
            api_client,
            prefix,
            [
                _op(
                    entity="sku",
                    op=operation,
                    entity_id=uuid.UUID(sku_id),
                    idempotency_key=uuid.uuid4(),
                    fields=fields,
                )
            ],
        )
        assert result["stopped"] is True
        assert result["results"][0]["status"] == "failed"
        assert "구매·시음" in result["results"][0]["detail"]
    assert api_client.get(f"{prefix}/products/{product['id']}").json() == before

    async def preserved() -> None:
        async with get_session_factory().begin() as session:
            model = Purchase if "purchase" in reference else TastingSession
            row = await session.get(model, uuid.UUID(record_id))
            assert row is not None and str(row.sku_id) == sku_id
            assert (row.deleted_at is not None) is reference.startswith("deleted_")

    assert api_client.portal is not None
    api_client.portal.call(preserved)


def test_used_sku_accepts_metadata_and_unchanged_volume(
    api_client: TestClient, prefix: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    _attach_reference(api_client, prefix, sku_id, "purchase")
    response = api_client.patch(
        f"{prefix}/skus/{sku_id}",
        json={"volume_ml": 700, "barcode": "2001234567890", "package_note": "상자"},
    )
    assert response.status_code == 200, response.text
    result = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="sku",
                op="update",
                entity_id=uuid.UUID(sku_id),
                fields={"volume_ml": 700, "package_note": "수정 상자"},
            )
        ],
    )
    assert result["results"][0]["status"] == "applied"
    assert result["results"][0]["snapshot"]["package_note"] == "수정 상자"


def test_unused_sku_can_change_volume_and_be_deleted_idempotently(
    api_client: TestClient, prefix: str
) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    assert api_client.patch(f"{prefix}/skus/{sku_id}", json={"volume_ml": 1000}).status_code == 200
    assert api_client.delete(f"{prefix}/skus/{sku_id}").status_code == 204
    assert api_client.delete(f"{prefix}/skus/{sku_id}").status_code == 204
    assert api_client.get(f"{prefix}/products/{product['id']}").json()["skus"] == []


def test_clean_tombstone_is_reused_only_by_explicit_online_create(
    api_client: TestClient, prefix: str
) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    assert api_client.delete(f"{prefix}/skus/{sku_id}").status_code == 204
    rejected_id = uuid.uuid4()
    synced = _batch(
        api_client,
        prefix,
        [
            _op(
                entity="sku",
                op="create",
                entity_id=rejected_id,
                fields={"product_id": product["id"], "volume_ml": 700},
            )
        ],
    )
    assert synced["results"][0]["status"] == "failed"
    restored = _post(api_client, f"{prefix}/products/{product['id']}/skus", {"volume_ml": 700})
    assert restored["id"] == sku_id
    assert all(row["id"] != str(rejected_id) for row in _pull(api_client, prefix)["changes"]["sku"])
    assert (
        api_client.post(
            f"{prefix}/products/{product['id']}/skus", json={"volume_ml": 700}
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    "protected", ["barcode", "package_note", "deleted_purchase", "deleted_tasting"]
)
def test_tombstone_with_metadata_or_history_is_not_restored(
    api_client: TestClient, prefix: str, protected: str
) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    if protected in {"barcode", "package_note"}:
        value = "2001234567890" if protected == "barcode" else "원래 포장"
        assert (
            api_client.patch(f"{prefix}/skus/{sku_id}", json={protected: value}).status_code == 200
        )
    else:
        _attach_reference(api_client, prefix, sku_id, protected)

    async def simulate_legacy_delete() -> None:
        async with get_session_factory().begin() as session:
            sku = await session.get(Sku, uuid.UUID(sku_id))
            assert sku is not None
            sku.deleted_at = datetime.datetime.now(datetime.UTC)

    assert api_client.portal is not None
    api_client.portal.call(simulate_legacy_delete)
    response = api_client.post(f"{prefix}/products/{product['id']}/skus", json={"volume_ml": 700})
    assert response.status_code == 409, response.text
    assert api_client.get(f"{prefix}/products/{product['id']}").json()["skus"] == []


def test_deleted_parent_blocks_reuse_and_hides_orphans_without_changing_original_rows(
    api_client: TestClient, prefix: str
) -> None:
    product, sku_id = _product_with_sku(api_client, prefix)
    purchase_id = _attach_reference(api_client, prefix, sku_id, "purchase")
    tasting_id = _attach_reference(api_client, prefix, sku_id, "tasting")
    bottle_id = api_client.get(f"{prefix}/purchases/{purchase_id}/bottles").json()[0]["id"]

    async def simulate_deleted_parent() -> None:
        async with get_session_factory().begin() as session:
            parent = await session.get(Product, uuid.UUID(product["id"]))
            assert parent is not None
            parent.deleted_at = datetime.datetime.now(datetime.UTC)

    assert api_client.portal is not None
    api_client.portal.call(simulate_deleted_parent)
    assert (
        api_client.patch(f"{prefix}/skus/{sku_id}", json={"package_note": "변경"}).status_code
        == 404
    )
    assert api_client.delete(f"{prefix}/skus/{sku_id}").status_code == 404
    assert api_client.post(f"{prefix}/purchases", json={"sku_id": sku_id}).status_code == 404
    assert (
        api_client.post(
            f"{prefix}/tastings", json={"sku_id": sku_id, "tasted_on": "2026-10-01"}
        ).status_code
        == 404
    )
    assert api_client.get(f"{prefix}/bottles/{bottle_id}").status_code == 404
    assert api_client.get(f"{prefix}/bottles").json() == []
    assert api_client.get(f"{prefix}/purchases").json() == []
    assert api_client.get(f"{prefix}/tastings").json() == []
    assert api_client.get(f"{prefix}/tastings/summary").json()["session_count"] == 0

    async def originals_remain() -> None:
        async with get_session_factory().begin() as session:
            for model, row_id in [
                (Sku, sku_id),
                (Purchase, purchase_id),
                (TastingSession, tasting_id),
            ]:
                row = await session.scalar(select(model).where(model.id == uuid.UUID(row_id)))
                assert row is not None and row.deleted_at is None

    api_client.portal.call(originals_remain)
