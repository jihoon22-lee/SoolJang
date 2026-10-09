"""구매 분할의 구매처 권한·원자성과 기존 잘못된 참조의 이름 노출을 검증한다."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.routes import purchases
from sooljang.infrastructure.database.models import Purchase, User, Vendor
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_purchases import _post, _product_with_sku, _vendor


def _invalid_vendor(client: TestClient, prefix: str, user_id: uuid.UUID, kind: str) -> uuid.UUID:
    if kind == "missing":
        return uuid.uuid4()
    if kind == "deleted":
        vendor = _vendor(client, prefix, "삭제한 합성 구매처")
        assert client.delete(f"{prefix}/vendors/{vendor['id']}").status_code == 204
        return uuid.UUID(vendor["id"])

    async def create_foreign_vendor() -> uuid.UUID:
        async with get_session_factory().begin() as session:
            user = User(
                email="split-other@example.com",
                display_name="분할 검증용 다른 사용자",
                password_hash="unused-test-hash",
            )
            session.add(user)
            await session.flush()
            assert user.id != user_id
            vendor = Vendor(user_id=user.id, name="다른 계정의 비공개 구매처")
            session.add(vendor)
            await session.flush()
            return vendor.id

    assert client.portal is not None
    return client.portal.call(create_foreign_vendor)


def _set_purchase_vendor(client: TestClient, purchase_id: str, vendor_id: uuid.UUID) -> None:
    async def change_reference() -> None:
        async with get_session_factory().begin() as session:
            await session.execute(
                update(Purchase)
                .where(Purchase.id == uuid.UUID(purchase_id))
                .values(vendor_id=vendor_id)
            )

    assert client.portal is not None
    client.portal.call(change_reference)


@pytest.mark.parametrize("kind", ["missing", "deleted", "foreign"])
def test_split_rejects_invalid_explicit_vendor_without_moving_any_bottle(
    api_client: TestClient, prefix: str, api_user_id: uuid.UUID, kind: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    vendor = _vendor(api_client, prefix, "유효한 합성 구매처")
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 2})
    invalid = _invalid_vendor(api_client, prefix, api_user_id, kind)
    bottles_path = f"{prefix}/purchases/{purchase['id']}/bottles"
    before = api_client.get(bottles_path).json()

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={
            "parts": [
                {"quantity": 1, "vendor_id": vendor["id"]},
                {"quantity": 1, "vendor_id": str(invalid)},
            ]
        },
    )

    assert response.status_code == 404, response.text
    assert api_client.get(f"{prefix}/purchases").json() == [purchase]
    assert api_client.get(bottles_path).json() == before


@pytest.mark.parametrize("kind", ["deleted", "foreign"])
def test_split_rejects_invalid_inherited_vendor_and_preserves_original_purchase(
    api_client: TestClient, prefix: str, api_user_id: uuid.UUID, kind: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id, "quantity": 2})
    invalid = _invalid_vendor(api_client, prefix, api_user_id, kind)
    _set_purchase_vendor(api_client, purchase["id"], invalid)
    before = api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={"parts": [{"quantity": 1}, {"quantity": 1}]},
    )

    assert response.status_code == 404, response.text
    remaining = api_client.get(f"{prefix}/purchases").json()
    assert len(remaining) == 1
    assert remaining[0]["id"] == purchase["id"]
    assert remaining[0]["quantity"] == 2
    assert api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json() == before


@pytest.mark.parametrize("kind", ["deleted", "foreign"])
def test_existing_invalid_vendor_name_is_hidden_in_list_and_update_response(
    api_client: TestClient, prefix: str, api_user_id: uuid.UUID, kind: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    purchase = _post(api_client, f"{prefix}/purchases", {"sku_id": sku_id})
    invalid = _invalid_vendor(api_client, prefix, api_user_id, kind)
    _set_purchase_vendor(api_client, purchase["id"], invalid)

    listed = api_client.get(f"{prefix}/purchases")
    edited = api_client.patch(
        f"{prefix}/purchases/{purchase['id']}", json={"discount_note": "합성 수정"}
    )

    assert listed.status_code == edited.status_code == 200
    assert listed.json()[0]["vendor_name"] is None
    assert edited.json()["vendor_name"] is None
    assert edited.json()["vendor_id"] == str(invalid)


def test_split_inherits_owned_vendor_without_changing_bottle_ids(
    api_client: TestClient, prefix: str
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    vendor = _vendor(api_client, prefix, "상속할 합성 구매처")
    purchase = _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": sku_id, "quantity": 2, "vendor_id": vendor["id"]},
    )
    before = api_client.get(f"{prefix}/purchases/{purchase['id']}/bottles").json()

    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={"parts": [{"quantity": 1}, {"quantity": 1}]},
    )

    assert response.status_code == 200, response.text
    assert all(part["vendor_name"] == vendor["name"] for part in response.json())
    after = [
        bottle
        for part in response.json()
        for bottle in api_client.get(f"{prefix}/purchases/{part['id']}/bottles").json()
    ]
    assert {bottle["id"] for bottle in after} == {bottle["id"] for bottle in before}


def test_split_requires_retry_when_inherited_vendor_changes_before_lock(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, sku_id = _product_with_sku(api_client, prefix)
    original_vendor = _vendor(api_client, prefix, "원래 합성 구매처")
    new_vendor = _vendor(api_client, prefix, "변경된 합성 구매처")
    purchase = _post(
        api_client,
        f"{prefix}/purchases",
        {"sku_id": sku_id, "quantity": 2, "vendor_id": original_vendor["id"]},
    )
    original_load = purchases._owned_purchase

    async def change_after_read(
        session: AsyncSession, user_id: uuid.UUID, purchase_id: uuid.UUID
    ) -> Purchase:
        row = await original_load(session, user_id, purchase_id)
        async with get_session_factory().begin() as edit:
            await edit.execute(
                update(Purchase)
                .where(Purchase.id == purchase_id)
                .values(vendor_id=uuid.UUID(new_vendor["id"]))
            )
        return row

    monkeypatch.setattr(purchases, "_owned_purchase", change_after_read)
    response = api_client.post(
        f"{prefix}/purchases/{purchase['id']}:split",
        json={"parts": [{"quantity": 1}, {"quantity": 1}]},
    )

    assert response.status_code == 409, response.text
    remaining = api_client.get(f"{prefix}/purchases").json()
    assert len(remaining) == 1
    assert remaining[0]["id"] == purchase["id"]
    assert remaining[0]["vendor_id"] == new_vendor["id"]
