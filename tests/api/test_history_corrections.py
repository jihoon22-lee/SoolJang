"""시음/구매 정정이 원본과 현재 상태를 보존하는 HTTP 회귀."""

import uuid
from typing import Any

from fastapi.testclient import TestClient

from tests.api.tasting_helpers import remove_tasting_record
from tests.api.test_tastings import _create_product_with_bottle


def _tasting(client: TestClient, prefix: str, bottle_id: str, **changes: Any) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/tastings",
        json={
            "bottle_id": bottle_id,
            "tasted_on": "2026-01-02",
            "poured_ml": 20,
            "rating": "4.5",
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _correct(row: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return dict(
        request_id=str(uuid.uuid4()),
        expected_updated_at=row["updated_at"],
        changes=changes,
        expected_bottles=[{"id": row["bottle"]["id"], "revision": row["bottle"]["revision"]}]
        if row["bottle"]
        else [],
        remaining_mode="preserve",
        final_bottles=[],
    )


def _purchase_payload(context: dict[str, Any], sku_id: str, volume: int) -> dict[str, Any]:
    return dict(
        request_id=str(uuid.uuid4()),
        expected_updated_at=context["purchase"]["updated_at"],
        target_sku_id=sku_id,
        target_sku_expected_volume_ml=volume,
        expected_bottles=[{"id": b["id"], "revision": b["revision"]} for b in context["bottles"]],
        expected_tastings=[
            {"id": t["id"], "updated_at": t["updated_at"]} for t in context["tastings"]
        ],
        final_bottles=[],
    )


class TestHistoryCorrections:
    def test_history_page_summary_context_and_date_filters(
        self, api_client: TestClient, prefix: str
    ) -> None:
        data = _create_product_with_bottle(api_client, prefix, quantity=2)
        bid = data["bottles"][0]["id"]
        first = _tasting(api_client, prefix, bid)
        second = _tasting(api_client, prefix, bid, tasted_on="2026-01-03")
        assert first["context"]["product_name"] == "테스트 위스키"
        assert first["context"]["volume_ml"] == 750
        assert first["purchase"]["id"] == data["purchase_id"]
        params = {
            "product_id": first["context"]["product_id"],
            "tasted_on_min": "2026-01-02",
            "tasted_on_max": "2026-01-03",
            "limit": 1,
        }
        page = api_client.get(f"{prefix}/tastings/page", params=params).json()
        assert [r["id"] for r in page["items"]] == [second["id"]]
        page2 = api_client.get(
            f"{prefix}/tastings/page", params={**params, "cursor": page["next_cursor"]}
        ).json()
        assert [r["id"] for r in page2["items"]] == [first["id"]]
        assert page2["next_cursor"] is None
        summary = api_client.get(
            f"{prefix}/tastings/summary", params={**params, "tasted_on_min": "2026-01-03"}
        ).json()
        assert summary["session_count"] == 1
        assert summary["total_poured_ml"] == 20
        assert (
            api_client.get(
                f"{prefix}/tastings/page",
                params={"tasted_on_min": "2026-02-01", "tasted_on_max": "2026-01-01"},
            ).status_code
            == 422
        )
        assert api_client.get(f"{prefix}/tastings/{first['id']}/attachments").json() == []

    def test_record_only_change_preserves_remaining_and_replays_original_response(
        self, api_client: TestClient, prefix: str
    ) -> None:
        data = _create_product_with_bottle(api_client, prefix)
        bid = data["bottles"][0]["id"]
        row = _tasting(api_client, prefix, bid)
        payload = _correct(row, poured_ml=40, note="정정한 노트")
        response = api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload)
        assert response.status_code == 200, response.text
        corrected = response.json()
        assert corrected["id"] == row["id"]
        assert corrected["poured_ml"] == 40
        assert corrected["bottle"]["remaining_ml"] == 730
        assert corrected["bottle"]["revision"] != row["bottle"]["revision"]
        _tasting(api_client, prefix, bid)
        assert (
            api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload).json()
            == corrected
        )
        assert api_client.get(f"{prefix}/bottles/{bid}").json()["remaining_ml"] == 710
        altered = {**payload, "changes": {"note": "다른 노트"}}
        assert (
            api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=altered).status_code
            == 409
        )
        assert (
            api_client.post(
                f"{prefix}/tastings/{row['id']}:correct",
                json={**payload, "request_id": str(uuid.uuid4())},
            ).status_code
            == 409
        )
        history = api_client.get(f"{prefix}/tastings/{row['id']}/history").json()
        assert len(history) == 1
        assert history[0]["detail"]["before"]["poured_ml"] == 20

    def test_move_tasting_between_products_requires_both_current_bottles(
        self, api_client: TestClient, prefix: str
    ) -> None:
        source = _create_product_with_bottle(api_client, prefix)
        target = _create_product_with_bottle(api_client, prefix, volume_ml=500)
        row = _tasting(api_client, prefix, source["bottles"][0]["id"])
        target_bottle = api_client.get(f"{prefix}/bottles/{target['bottles'][0]['id']}").json()
        payload = _correct(row, bottle_id=target_bottle["id"])
        url = f"{prefix}/tastings/{row['id']}:correct"
        assert api_client.post(url, json=payload).status_code == 409
        payload["expected_bottles"].append(
            {"id": target_bottle["id"], "revision": target_bottle["revision"]}
        )
        result = api_client.post(url, json=payload)
        assert result.status_code == 200, result.text
        assert result.json()["context"]["volume_ml"] == 500
        assert result.json()["sku_id"] == target["sku_id"]
        assert result.json()["bottle"]["status"] == "unopened"
        assert api_client.get(f"{prefix}/bottles/{row['bottle_id']}").json()["remaining_ml"] == 730

    def test_standalone_target_checks_locked_volume_and_can_return_to_bottle(
        self, api_client: TestClient, prefix: str
    ) -> None:
        data = _create_product_with_bottle(api_client, prefix)
        row = _tasting(api_client, prefix, data["bottles"][0]["id"])
        payload = _correct(row, bottle_id=None, sku_id=data["sku_id"])
        url = f"{prefix}/tastings/{row['id']}:correct"
        payload["target_sku_expected_volume_ml"] = 500
        assert api_client.post(url, json=payload).status_code == 409
        payload["target_sku_expected_volume_ml"] = 750
        response = api_client.post(url, json=payload)
        assert response.status_code == 200, response.text
        standalone = response.json()
        assert standalone["purchase"] is None and standalone["bottle"] is None
        bottle = api_client.get(f"{prefix}/bottles/{row['bottle_id']}").json()
        payload2 = _correct(standalone, bottle_id=bottle["id"])
        payload2["expected_bottles"] = [{"id": bottle["id"], "revision": bottle["revision"]}]
        response = api_client.post(url, json=payload2)
        assert response.status_code == 200, response.text
        assert response.json()["bottle"]["remaining_ml"] == 730

    def test_final_states_validate_atomically_and_delete_invalidates_revision(
        self, api_client: TestClient, prefix: str
    ) -> None:
        data = _create_product_with_bottle(api_client, prefix)
        row = _tasting(api_client, prefix, data["bottles"][0]["id"])
        payload = _correct(row, poured_ml=100)
        payload.update(
            remaining_mode="set_final",
            final_bottles=[
                dict(
                    id=row["bottle_id"],
                    status="open",
                    remaining_ml=800,
                    opened_on="2026-01-02",
                    finished_on=None,
                )
            ],
        )
        url = f"{prefix}/tastings/{row['id']}:correct"
        assert api_client.post(url, json=payload).status_code == 422
        assert api_client.get(f"{prefix}/tastings/{row['id']}").json()["poured_ml"] == 20
        payload["final_bottles"][0]["remaining_ml"] = 650
        result = api_client.post(url, json=payload)
        assert result.status_code == 200, result.text
        revised = result.json()["bottle"]
        assert revised["remaining_ml"] == 650
        assert remove_tasting_record(api_client, prefix, row["id"]).status_code == 200
        bottle = api_client.get(f"{prefix}/bottles/{row['bottle_id']}").json()
        assert bottle["revision"] != revised["revision"] and bottle["remaining_ml"] == 650

    def test_purchase_correction_updates_live_and_deleted_tastings_preserving_ids(
        self, api_client: TestClient, prefix: str
    ) -> None:
        data = _create_product_with_bottle(api_client, prefix, quantity=2)
        first = _tasting(api_client, prefix, data["bottles"][0]["id"])
        deleted = _tasting(api_client, prefix, data["bottles"][1]["id"])
        remove_tasting_record(api_client, prefix, deleted["id"])
        product_id = first["context"]["product_id"]
        sku = api_client.post(
            f"{prefix}/products/{product_id}/skus", json={"volume_ml": 1000}
        ).json()
        context_url = f"{prefix}/purchases/{data['purchase_id']}/correction-context"
        before = api_client.get(context_url).json()
        payload = _purchase_payload(before, sku["id"], 1000)
        result = api_client.post(
            f"{prefix}/purchases/{data['purchase_id']}:correct-sku", json=payload
        )
        assert result.status_code == 200, result.text
        after = result.json()
        assert after["purchase"]["sku_id"] == sku["id"]
        assert {b["id"] for b in after["bottles"]} == {b["id"] for b in before["bottles"]}
        assert {t["id"] for t in after["tastings"]} == {first["id"], deleted["id"]}
        assert all(t["sku_id"] == sku["id"] for t in after["tastings"])
        assert (
            next(t for t in after["tastings"] if t["id"] == deleted["id"])["deleted_at"] is not None
        )
        assert all(b["remaining_ml"] == 730 for b in after["bottles"])
        assert all(
            a["revision"] != b["revision"]
            for a, b in zip(after["bottles"], before["bottles"], strict=True)
        )
        assert (
            api_client.post(
                f"{prefix}/purchases/{data['purchase_id']}:correct-sku", json=payload
            ).json()
            == after
        )

    def test_smaller_purchase_sku_requires_final_remaining_and_exact_guards(
        self, api_client: TestClient, prefix: str
    ) -> None:
        data = _create_product_with_bottle(api_client, prefix)
        row = _tasting(api_client, prefix, data["bottles"][0]["id"])
        sku = api_client.post(
            f"{prefix}/products/{row['context']['product_id']}/skus", json={"volume_ml": 500}
        ).json()
        before = api_client.get(
            f"{prefix}/purchases/{data['purchase_id']}/correction-context"
        ).json()
        payload = _purchase_payload(before, sku["id"], 500)
        url = f"{prefix}/purchases/{data['purchase_id']}:correct-sku"
        assert api_client.post(url, json=payload).status_code == 422
        payload["expected_tastings"] = []
        assert api_client.post(url, json=payload).status_code == 409
        payload["expected_tastings"] = [{"id": row["id"], "updated_at": row["updated_at"]}]
        payload["final_bottles"] = [
            dict(
                id=row["bottle_id"],
                status="open",
                remaining_ml=400,
                opened_on="2026-01-02",
                finished_on=None,
            )
        ]
        response = api_client.post(url, json=payload)
        assert response.status_code == 200, response.text
        assert response.json()["bottles"][0]["remaining_ml"] == 400


def test_attachment_survives_tasting_move_and_purchase_correction(
    api_client: TestClient, prefix: str
) -> None:
    from tests.api.test_attachments import _minimal_png

    data = _create_product_with_bottle(api_client, prefix, quantity=2)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    attachment = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("tasting.png", _minimal_png(), "image/png")},
        data={"kind": "tasting", "tasting_session_id": row["id"]},
    )
    assert attachment.status_code == 201, attachment.text
    payload = _correct(row, poured_ml=30, bottle_id=data["bottles"][1]["id"])
    payload["expected_bottles"].append(
        {"id": data["bottles"][1]["id"], "revision": data["bottles"][1]["revision"]}
    )
    response = api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload)
    assert response.status_code == 200, response.text
    sku = api_client.post(
        f"{prefix}/products/{row['context']['product_id']}/skus", json={"volume_ml": 1000}
    ).json()
    context = api_client.get(f"{prefix}/purchases/{data['purchase_id']}/correction-context").json()
    result = api_client.post(
        f"{prefix}/purchases/{data['purchase_id']}:correct-sku",
        json=_purchase_payload(context, sku["id"], 1000),
    )
    assert result.status_code == 200, result.text
    listed = api_client.get(f"{prefix}/tastings/{row['id']}/attachments")
    assert [a["id"] for a in listed.json()] == [attachment.json()["id"]]
    assert listed.headers["cache-control"] == "private, no-store"
    assert (
        api_client.get(f"{prefix}/attachments/{attachment.json()['id']}/content").content
        == _minimal_png()
    )


def test_expired_receipt_does_not_repeat_mutation(api_client: TestClient, prefix: str) -> None:
    import datetime

    from sooljang.infrastructure.database.models import OutboxReceipt
    from sooljang.infrastructure.database.session import get_session_factory

    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    payload = _correct(row, note="보관 기간 정정")
    url = f"{prefix}/tastings/{row['id']}:correct"
    result = api_client.post(url, json=payload)
    assert result.status_code == 200, result.text

    async def expire() -> None:
        async with get_session_factory().begin() as session:
            receipt = await session.get(OutboxReceipt, uuid.UUID(payload["request_id"]))
            assert receipt is not None
            receipt.created_at = datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=31)

    assert api_client.portal is not None
    api_client.portal.call(expire)
    assert api_client.post(url, json=payload).status_code == 409
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == result.json()


def test_all_bottle_states_and_soft_deleted_children_preserve_identity(
    api_client: TestClient, prefix: str
) -> None:
    import datetime

    from sooljang.infrastructure.database.models import Bottle, TastingSession
    from sooljang.infrastructure.database.session import get_session_factory

    data = _create_product_with_bottle(api_client, prefix, quantity=6)
    rows = [_tasting(api_client, prefix, b["id"]) for b in data["bottles"][1:]]
    for bottle, action in zip(data["bottles"][2:5], ["finish", "gift", "sell"], strict=True):
        result = api_client.post(f"{prefix}/bottles/{bottle['id']}:{action}", json={})
        assert result.status_code == 200, result.text

    async def soft_delete() -> None:
        async with get_session_factory().begin() as session:
            bottle = await session.get(Bottle, uuid.UUID(data["bottles"][5]["id"]))
            tasting = await session.get(TastingSession, uuid.UUID(rows[-1]["id"]))
            assert bottle is not None and tasting is not None
            bottle.deleted_at = tasting.deleted_at = datetime.datetime.now(datetime.UTC)

    assert api_client.portal is not None
    api_client.portal.call(soft_delete)
    sku = api_client.post(
        f"{prefix}/products/{rows[0]['context']['product_id']}/skus", json={"volume_ml": 1000}
    ).json()
    context_url = f"{prefix}/purchases/{data['purchase_id']}/correction-context"
    before = api_client.get(context_url).json()
    result = api_client.post(
        f"{prefix}/purchases/{data['purchase_id']}:correct-sku",
        json=_purchase_payload(before, sku["id"], 1000),
    )
    assert result.status_code == 200, result.text
    after = result.json()
    for old, new in zip(before["bottles"], after["bottles"], strict=True):
        assert new["id"] == old["id"] and new["label_no"] == old["label_no"]
        assert new["deleted_at"] == old["deleted_at"] and new["status"] == old["status"]
        assert new["remaining_ml"] == old["remaining_ml"]
        assert new["revision"] != old["revision"]
    assert all(t["sku_id"] == sku["id"] for t in after["tastings"])
    assert len(after["bottles"]) == 6 and len(after["tastings"]) == 5


def test_correction_reads_and_writes_do_not_expose_other_users_records(
    api_client: TestClient, prefix: str
) -> None:
    from sooljang.application.auth import hash_password
    from sooljang.infrastructure.database.models import User
    from sooljang.infrastructure.database.session import get_session_factory

    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    context = api_client.get(f"{prefix}/purchases/{data['purchase_id']}/correction-context").json()
    payload = _correct(row, note="비공개")
    assert (
        api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload).status_code == 200
    )

    async def another_user() -> None:
        async with get_session_factory().begin() as session:
            session.add(
                User(
                    email="correction-other@example.com",
                    display_name="다른 사용자",
                    password_hash=hash_password("correction-test-password"),
                )
            )

    assert api_client.portal is not None
    api_client.portal.call(another_user)
    response = api_client.post(
        f"{prefix}/auth/login",
        json={"email": "correction-other@example.com", "password": "correction-test-password"},
    )
    assert response.status_code == 200
    api_client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    for path in [
        f"/tastings/{row['id']}",
        f"/tastings/{row['id']}/attachments",
        f"/tastings/{row['id']}/history",
        f"/bottles/{row['bottle_id']}/correction-context",
        f"/purchases/{data['purchase_id']}/correction-context",
    ]:
        assert api_client.get(f"{prefix}{path}").status_code == 404
    assert api_client.get(f"{prefix}/tastings/page").json()["items"] == []
    assert (
        api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload).status_code == 409
    )
    payload["request_id"] = str(uuid.uuid4())
    assert (
        api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload).status_code == 404
    )
    assert (
        api_client.post(
            f"{prefix}/purchases/{data['purchase_id']}:correct-sku",
            json=_purchase_payload(context, data["sku_id"], 750),
        ).status_code
        == 404
    )


def test_purchase_correction_does_not_move_standalone_or_other_purchase_tastings(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    standalone = api_client.post(
        f"{prefix}/tastings", json={"sku_id": data["sku_id"], "tasted_on": "2026-01-01"}
    ).json()
    other_purchase = api_client.post(
        f"{prefix}/purchases", json={"sku_id": data["sku_id"], "quantity": 1}
    ).json()
    other_bottle = api_client.get(f"{prefix}/purchases/{other_purchase['id']}/bottles").json()[0]
    other_tasting = _tasting(api_client, prefix, other_bottle["id"])
    sku = api_client.post(
        f"{prefix}/products/{row['context']['product_id']}/skus", json={"volume_ml": 1000}
    ).json()
    before = api_client.get(f"{prefix}/purchases/{data['purchase_id']}/correction-context").json()
    result = api_client.post(
        f"{prefix}/purchases/{data['purchase_id']}:correct-sku",
        json=_purchase_payload(before, sku["id"], 1000),
    )
    assert result.status_code == 200, result.text
    for tasting in [standalone, other_tasting]:
        assert api_client.get(f"{prefix}/tastings/{tasting['id']}").json() == tasting
    assert (
        api_client.get(f"{prefix}/bottles/{other_bottle['id']}").json()["revision"]
        == other_tasting["bottle"]["revision"]
    )


def test_invalid_correction_inputs_leave_tasting_and_bottle_unchanged(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    url = f"{prefix}/tastings/{row['id']}:correct"
    for changes in [
        {"rating": "3.7"},
        {"tasted_on": None},
        {"sku_id": None},
        {"bottle_id": None},
        {"poured_ml": 2**32},
        {"place": "x" * 201},
    ]:
        result = api_client.post(url, json=_correct(row, **changes))
        assert result.status_code == 422, result.text
    duplicate = _correct(row, note="중복 방지")
    duplicate["expected_bottles"] *= 2
    assert api_client.post(url, json=duplicate).status_code == 422
    for final in [
        dict(status="finished", remaining_ml=20, opened_on="2026-01-02", finished_on="2026-01-03"),
        dict(status="open", remaining_ml=20, opened_on="2026-01-03", finished_on="2026-01-01"),
        dict(status="unopened", remaining_ml=700, opened_on=None, finished_on=None),
        dict(status="open", remaining_ml=0, opened_on="2026-01-02", finished_on=None),
    ]:
        payload = _correct(row, note="최종 상태 검증")
        payload.update(
            remaining_mode="set_final", final_bottles=[{"id": row["bottle_id"], **final}]
        )
        assert api_client.post(url, json=payload).status_code == 422
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == row


def test_correction_invalidates_old_remaining_undo(api_client: TestClient, prefix: str) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    response = api_client.post(
        f"{prefix}/tastings/{row['id']}:correct", json=_correct(row, note="정정")
    )
    assert response.status_code == 200, response.text
    undo = api_client.post(
        f"{prefix}/bottles/{row['bottle_id']}:remaining",
        json={"remaining_ml": 750, "expected_revision": row["bottle"]["revision"]},
    )
    assert undo.status_code == 409
    assert api_client.get(f"{prefix}/bottles/{row['bottle_id']}").json()["remaining_ml"] == 730


def test_tasting_date_correction_must_fit_known_bottle_dates(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    finished = api_client.post(
        f"{prefix}/bottles/{row['bottle_id']}:finish", json={"finished_on": "2026-01-03"}
    )
    assert finished.status_code == 200, finished.text
    row = api_client.get(f"{prefix}/tastings/{row['id']}").json()
    url = f"{prefix}/tastings/{row['id']}:correct"
    for date in ["2026-01-01", "2026-01-04"]:
        result = api_client.post(url, json=_correct(row, tasted_on=date))
        assert result.status_code == 422, result.text
        assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == row
    result = api_client.post(url, json=_correct(row, tasted_on="2026-01-03"))
    assert result.status_code == 200, result.text
    assert result.json()["bottle"]["finished_on"] == "2026-01-03"


def test_moving_tasting_requires_explicit_final_dates_that_include_tasting(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix, quantity=2)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    target = api_client.post(
        f"{prefix}/bottles/{data['bottles'][1]['id']}:open", json={"opened_on": "2026-01-03"}
    ).json()
    payload = _correct(row, bottle_id=target["id"])
    payload["expected_bottles"].append({"id": target["id"], "revision": target["revision"]})
    url = f"{prefix}/tastings/{row['id']}:correct"
    response = api_client.post(url, json=payload)
    assert response.status_code == 422, response.text
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == row
    payload["remaining_mode"] = "set_final"
    payload["final_bottles"] = [
        dict(
            id=b["id"],
            status="open",
            remaining_ml=b["remaining_ml"],
            opened_on="2026-01-02",
            finished_on=None,
        )
        for b in [row["bottle"], target]
    ]
    response = api_client.post(url, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["bottle"]["opened_on"] == "2026-01-02"
    assert response.json()["bottle"]["remaining_ml"] == 750


def test_setting_final_dates_cannot_exclude_unchanged_tasting_date(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    payload = _correct(row, note="날짜도 함께 확인")
    payload.update(
        remaining_mode="set_final",
        final_bottles=[
            dict(
                id=row["bottle_id"],
                status="open",
                remaining_ml=730,
                opened_on="2026-01-03",
                finished_on=None,
            )
        ],
    )
    response = api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload)
    assert response.status_code == 422, response.text
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == row


def test_legacy_date_mismatch_allows_content_only_correction(
    api_client: TestClient, prefix: str
) -> None:
    import datetime

    from sooljang.infrastructure.database.models import Bottle
    from sooljang.infrastructure.database.session import get_session_factory

    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])

    async def legacy_opening() -> None:
        async with get_session_factory().begin() as session:
            bottle = await session.get(Bottle, uuid.UUID(row["bottle_id"]))
            assert bottle is not None
            bottle.opened_on = datetime.date(2026, 1, 3)

    assert api_client.portal is not None
    api_client.portal.call(legacy_opening)
    row = api_client.get(f"{prefix}/tastings/{row['id']}").json()
    result = api_client.post(
        f"{prefix}/tastings/{row['id']}:correct",
        json=_correct(
            row,
            note="기존 날짜를 보존하고 노트만 수정",
            tasted_on=row["tasted_on"],
            bottle_id=row["bottle_id"],
        ),
    )
    assert result.status_code == 200, result.text
    assert result.json()["tasted_on"] == "2026-01-02"
    assert result.json()["bottle"]["opened_on"] == "2026-01-03"


def test_unknown_finished_date_and_future_date_follow_existing_record_policy(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    payload = _correct(row, tasted_on="2099-01-02")
    payload.update(
        remaining_mode="set_final",
        final_bottles=[
            dict(
                id=row["bottle_id"],
                status="finished",
                remaining_ml=0,
                opened_on=None,
                finished_on=None,
            )
        ],
    )
    response = api_client.post(f"{prefix}/tastings/{row['id']}:correct", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["tasted_on"] == "2099-01-02"
    assert response.json()["bottle"]["finished_on"] is None


def test_reused_request_id_distinguishes_omitted_note_from_explicit_clear(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"], note="보존할 원래 노트")
    payload = _correct(row)
    url = f"{prefix}/tastings/{row['id']}:correct"
    original = api_client.post(url, json=payload)
    assert original.status_code == 200, original.text
    assert original.json()["note"] == "보존할 원래 노트"
    altered = {**payload, "changes": {"note": None}}
    result = api_client.post(url, json=altered)
    assert result.status_code == 409, result.text
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == original.json()


def test_reused_request_id_distinguishes_omitted_bottle_from_standalone_target(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    payload = _correct(row, sku_id=row["sku_id"])
    payload["target_sku_expected_volume_ml"] = 750
    url = f"{prefix}/tastings/{row['id']}:correct"
    original = api_client.post(url, json=payload)
    assert original.status_code == 200, original.text
    altered = {**payload, "changes": {"sku_id": row["sku_id"], "bottle_id": None}}
    result = api_client.post(url, json=altered)
    assert result.status_code == 409, result.text
    assert api_client.get(f"{prefix}/tastings/{row['id']}").json() == original.json()


def test_same_frozen_correction_retries_with_different_json_key_order(
    api_client: TestClient, prefix: str
) -> None:
    data = _create_product_with_bottle(api_client, prefix)
    row = _tasting(api_client, prefix, data["bottles"][0]["id"])
    payload = _correct(row, note=None, rating="4.0")
    url = f"{prefix}/tastings/{row['id']}:correct"
    original = api_client.post(url, json=payload)
    assert original.status_code == 200, original.text
    reordered = dict(reversed(list(payload.items())))
    reordered["changes"] = dict(reversed(list(payload["changes"].items())))
    reordered["expected_bottles"] = [
        dict(reversed(list(guard.items()))) for guard in payload["expected_bottles"]
    ]
    assert api_client.post(url, json=reordered).json() == original.json()
    assert len(api_client.get(f"{prefix}/tastings/{row['id']}/history").json()) == 1
