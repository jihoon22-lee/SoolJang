"""오래된 시음도 같은 날짜의 기록 누락 없이 끝까지 읽을 수 있어야 한다."""

import datetime
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from sooljang.api.pagination import Cursor
from sooljang.api.schemas.tasting import TastingOut
from sooljang.infrastructure.database.models import Bottle, User
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_purchases import _post
from tests.api.test_tastings import _create_product_with_bottle


def test_bottle_tasting_pages_reach_oldest_note_without_duplicates_after_insert_and_delete(
    api_client: TestClient, prefix: str
) -> None:
    setup = _create_product_with_bottle(api_client, prefix, quantity=2)
    bottle_id, other_bottle_id = (bottle["id"] for bottle in setup["bottles"])
    records = [
        _post(
            api_client,
            f"{prefix}/tastings",
            {
                "bottle_id": bottle_id,
                "tasted_on": "2026-09-30" if index < 3 else "2026-10-01",
                "note": f"합성 시음 노트 {index}",
            },
        )
        for index in range(52)
    ]
    _post(
        api_client,
        f"{prefix}/tastings",
        {"bottle_id": other_bottle_id, "tasted_on": "2026-10-02", "note": "다른 병의 시음"},
    )
    removed = records.pop(10)
    assert api_client.delete(f"{prefix}/tastings/{removed['id']}").status_code == 204
    expected = sorted(records, key=lambda row: (row["tasted_on"], row["id"]), reverse=True)
    expected_records = [{key: row[key] for key in TastingOut.model_fields} for row in expected]
    path = f"{prefix}/bottles/{bottle_id}/tastings"

    first_response = api_client.get(f"{path}/page")
    assert first_response.status_code == 200, first_response.text
    first = first_response.json()
    assert [
        {key: row[key] for key in TastingOut.model_fields} for row in first["items"]
    ] == expected_records[:50]
    current_revision = api_client.get(f"{prefix}/bottles/{bottle_id}").json()["revision"]
    assert all(row["bottle"]["revision"] == current_revision for row in first["items"])
    assert first["next_cursor"] is not None
    assert [
        {key: row[key] for key in TastingOut.model_fields} for row in api_client.get(path).json()
    ] == expected_records[:50]

    # 첫 페이지를 보는 사이 새 시음이 생기거나 경계 행이 삭제되어도 다음 구간은 이어진다.
    _post(
        api_client,
        f"{prefix}/tastings",
        {"bottle_id": bottle_id, "tasted_on": "2026-10-02", "note": "새로 추가한 시음"},
    )
    assert api_client.delete(f"{prefix}/tastings/{first['items'][-1]['id']}").status_code == 204
    second_response = api_client.get(f"{path}/page", params={"cursor": first["next_cursor"]})
    assert second_response.status_code == 200, second_response.text
    second = second_response.json()
    assert second["next_cursor"] is None
    assert [
        {key: row[key] for key in TastingOut.model_fields} for row in second["items"]
    ] == expected_records[50:]
    current_revision = api_client.get(f"{prefix}/bottles/{bottle_id}").json()["revision"]
    assert all(row["bottle"]["revision"] == current_revision for row in second["items"])
    combined = first["items"] + second["items"]
    assert len({row["id"] for row in combined}) == 51
    assert combined[-1]["note"] == expected[-1]["note"]


def test_tasting_page_handles_empty_history_and_rejects_invalid_cursor_or_limit(
    api_client: TestClient, prefix: str
) -> None:
    setup = _create_product_with_bottle(api_client, prefix)
    path = f"{prefix}/bottles/{setup['bottles'][0]['id']}/tastings/page"
    assert api_client.get(path).json() == {"items": [], "next_cursor": None}
    for cursor in ["invalid", *[Cursor(value, uuid.uuid4()).encode() for value in (None, 42, "x")]]:
        response = api_client.get(path, params={"cursor": cursor})
        assert response.status_code == 422, response.text
    for limit in (0, 201):
        assert api_client.get(path, params={"limit": limit}).status_code == 422
    assert api_client.get(path, params={"limit": 200}).status_code == 200


@pytest.mark.parametrize("kind", ["missing", "deleted", "foreign"])
def test_tasting_page_rejects_unavailable_bottle(
    api_client: TestClient, prefix: str, kind: str
) -> None:
    setup = _create_product_with_bottle(api_client, prefix)
    bottle_id = uuid.UUID(setup["bottles"][0]["id"])

    async def make_unavailable() -> None:
        async with get_session_factory().begin() as session:
            if kind == "deleted":
                await session.execute(
                    update(Bottle)
                    .where(Bottle.id == bottle_id)
                    .values(deleted_at=datetime.datetime.now(datetime.UTC))
                )
            elif kind == "foreign":
                other = User(
                    email="history-other@example.com",
                    display_name="합성 다른 사용자",
                    password_hash="unused-test-hash",
                )
                session.add(other)
                await session.flush()
                await session.execute(
                    update(Bottle).where(Bottle.id == bottle_id).values(user_id=other.id)
                )

    assert api_client.portal is not None
    api_client.portal.call(make_unavailable)
    if kind == "missing":
        bottle_id = uuid.uuid4()
    response = api_client.get(f"{prefix}/bottles/{bottle_id}/tastings/page")
    assert response.status_code == 404
