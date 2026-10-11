"""시음 삭제·복구는 조회 버전과 원본 ID를 보존하고 잔량에 영향을 주지 않는다."""

import uuid
from typing import Any

from fastapi.testclient import TestClient

from tests.api.test_history_corrections import _correct, _tasting
from tests.api.test_tastings import _create_product_with_bottle


def _command(row: dict[str, Any]) -> dict[str, str]:
    return {"request_id": str(uuid.uuid4()), "expected_updated_at": row["updated_at"]}


def test_stale_delete_rejects_a_newer_correction(api_client: TestClient, prefix: str) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    corrected = api_client.post(
        f"{prefix}/tastings/{row['id']}:correct", json=_correct(row, note="다른 기기의 수정")
    )
    assert corrected.status_code == 200, corrected.text
    removed = api_client.request("DELETE", f"{prefix}/tastings/{row['id']}", json=_command(row))
    assert removed.status_code == 409, removed.text
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json()["note"] == "다른 기기의 수정"


def test_delete_restore_and_replay_preserve_id_and_current_remaining(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    bid = data["bottles"][0]["id"]
    row = _tasting(api_client, prefix, bid, note="복구할 일반 메모")
    from tests.api.test_attachments import _minimal_png

    attachment = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("tasting.png", _minimal_png(), "image/png")},
        data={"kind": "tasting", "tasting_session_id": row["id"]},
    )
    assert attachment.status_code == 201, attachment.text
    payload = _command(row)
    url = f"{prefix}/tastings/{row['id']}"
    removed = api_client.request("DELETE", url, json=payload)
    assert removed.status_code == 200, removed.text
    deleted = removed.json()
    assert deleted["deleted_at"] is not None
    assert api_client.request("DELETE", url, json=payload).json() == deleted
    _tasting(api_client, prefix, bid)
    restore = _command(deleted)
    restored = api_client.post(f"{url}:restore", json=restore)
    assert restored.status_code == 200, restored.text
    assert restored.json()["id"] == row["id"] and restored.json()["deleted_at"] is None
    assert api_client.post(f"{url}:restore", json=restore).json() == restored.json()
    assert api_client.request("DELETE", url, json=payload).json() == deleted
    assert api_client.get(url).json()["note"] == row["note"]
    assert [item["id"] for item in api_client.get(f"{url}/attachments").json()] == [
        attachment.json()["id"]
    ]
    assert (
        api_client.get(f"{prefix}/attachments/{attachment.json()['id']}/content").content
        == _minimal_png()
    )
    assert api_client.get(f"{prefix}/bottles/{bid}").json()["remaining_ml"] == 710
    assert api_client.post(f"{url}:restore", json=_command(deleted)).status_code == 409


def test_standalone_tasting_can_be_deleted_and_restored(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    created = api_client.post(
        f"{prefix}/tastings", json={"sku_id": data["sku_id"], "tasted_on": "2026-01-02"}
    ).json()
    url = f"{prefix}/tastings/{created['id']}"
    removed = api_client.request("DELETE", url, json=_command(created))
    assert removed.status_code == 200, removed.text
    restored = api_client.post(f"{url}:restore", json=_command(removed.json()))
    assert restored.status_code == 200, restored.text
    assert api_client.get(url).json()["bottle_id"] is None


def test_unversioned_delete_is_refused(api_client: TestClient, prefix: str) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    assert api_client.delete(f"{prefix}/tastings/{row['id']}").status_code == 409
    assert api_client.get(f"{prefix}/tastings/{row['id']}").status_code == 200


def test_another_user_cannot_restore_or_replay_deleted_tasting(
    api_client: TestClient, prefix: str
) -> None:
    from sooljang.application.auth import hash_password
    from sooljang.infrastructure.database.models import User
    from sooljang.infrastructure.database.session import get_session_factory

    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    url = f"{prefix}/tastings/{row['id']}"
    command = _command(row)
    removed = api_client.request("DELETE", url, json=command)
    assert removed.status_code == 200

    async def another_user() -> None:
        async with get_session_factory().begin() as session:
            session.add(
                User(
                    email="restore-other@example.com",
                    display_name="다른 계정",
                    password_hash=hash_password("restore-test-password"),
                )
            )

    assert api_client.portal is not None
    api_client.portal.call(another_user)
    login = api_client.post(
        f"{prefix}/auth/login",
        json={"email": "restore-other@example.com", "password": "restore-test-password"},
    )
    assert login.status_code == 200
    api_client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    assert api_client.post(f"{url}:restore", json=_command(removed.json())).status_code == 404
    assert api_client.request("DELETE", url, json=command).status_code == 409
    assert api_client.get(url).status_code == 404
