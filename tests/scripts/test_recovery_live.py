"""Opt-in PostgreSQL 복원: 합성 앱 데이터만, 명시된 recovery_test DB만 사용한다.

환경 변수(값을 기록하지 않음): SOOLJANG_RUN_RECOVERY_TESTS,
SOOLJANG_RECOVERY_TEST_SOURCE, PGHOST, PGPORT, PGUSER, SOOLJANG_PG_BIN.
별도 *_restored DB를 생성·제거하므로 일반 CI/로컬 실행에서는 자동 실행하지 않는다.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import psycopg
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from psycopg import sql
from sqlalchemy import select
from test_recovery import recovery
from tests.api.test_price_watch_worker import prepare_delivery, run_async
from tests.infrastructure.test_web_push import PRIVATE

from sooljang.api.app import API_PREFIX, create_app
from sooljang.api.routes.auth import CSRF_HEADER
from sooljang.application.auth import reset_rate_limiter
from sooljang.application.price_watch_worker import claim_delivery, worker_tick
from sooljang.config import get_settings
from sooljang.infrastructure.database.models import PushDelivery, PushSubscription
from sooljang.infrastructure.database.session import (
    get_engine,
    get_session_factory,
    reset_database_state,
)
from sooljang.infrastructure.storage import sniff_image_extension

pytestmark = [
    pytest.mark.requires_db,
    pytest.mark.skipif(
        os.environ.get("SOOLJANG_RUN_RECOVERY_TESTS") != "1",
        reason="격리 복구 DB opt-in이 필요합니다",
    ),
]


def url(database: str) -> str:
    return (
        f"postgresql+psycopg://{os.environ['PGUSER']}@{os.environ['PGHOST']}:"
        f"{os.environ['PGPORT']}/{database}"
    )


@pytest.fixture
def databases(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[str, str]]:
    source = os.environ["SOOLJANG_RECOVERY_TEST_SOURCE"]
    assert source.endswith("_recovery_test") and source != "sooljang_test"
    target = source + "_restored"
    assert len(target) <= 63
    with psycopg.connect(dbname="postgres", autocommit=True) as admin:
        existing = {row[0] for row in admin.execute("SELECT datname FROM pg_database")}
        if source not in existing:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(source)))
        # 이미 있으면 다른 작업의 대상일 수 있다. 강제 삭제하지 않는다.
        assert target not in existing, "이전 격리 target이 남아 있습니다; 내용을 먼저 확인하세요"
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target)))
    try:
        with psycopg.connect(dbname=source, autocommit=True) as connection:
            connection.execute("DROP SCHEMA public CASCADE")
            connection.execute("CREATE SCHEMA public")
        monkeypatch.setenv("SOOLJANG_DATABASE_URL", url(source))
        get_settings.cache_clear()
        reset_database_state()
        command.upgrade(Config(str(Path(__file__).resolve().parents[2] / "alembic.ini")), "head")
        yield source, target
    finally:
        with psycopg.connect(dbname="postgres", autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(target)))


def post(
    client: TestClient, path: str, payload: dict[str, Any], *, expected_status: int = 201
) -> Any:
    response = client.post(f"{API_PREFIX}/{path}", json=payload)
    assert response.status_code == expected_status, response.text
    return response.json()


def login(client: TestClient) -> None:
    response = client.post(
        f"{API_PREFIX}/auth/login",
        json={"email": "recovery@example.com", "password": "recovery-synthetic-1234"},
    )
    assert response.status_code == 200, response.text
    client.headers[CSRF_HEADER] = response.json()["csrf_token"]


def release_connections(client: TestClient) -> None:
    assert client.portal is not None
    client.portal.call(get_engine().dispose)
    reset_database_state()


# 전 행·전 필드의 digest를 비교한다. 실패 출력에도 암호문/구독 본문을 노출하지 않는다.
RECOVERY_TABLES = (
    "interest",
    "external_offer",
    "external_price_observation",
    "storage_location",
    "bottle_placement",
    "bottle_movement",
    "stocktake",
    "price_watch",
    "price_watch_run",
    "price_notification",
    "push_subscription",
    "push_delivery",
)


def record_digests(database: str) -> dict[str, tuple[int, str]]:
    result = {}
    with psycopg.connect(dbname=database) as connection:
        for table in RECOVERY_TABLES:
            rows = connection.execute(
                sql.SQL("SELECT to_jsonb(record) FROM {} AS record ORDER BY id").format(
                    sql.Identifier(table)
                )
            ).fetchall()
            assert rows, f"복구 fixture가 비었습니다: {table}"
            payload = json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()
            result[table] = (len(rows), hashlib.sha256(payload).hexdigest())
    return result


def preserve_collection_fixture(client: TestClient, bottle_id: str) -> list[str]:
    location = post(client, "collection/locations", {"name": "합성 복구 찬장", "kind": "cabinet"})
    placement = client.put(
        f"{API_PREFIX}/collection/bottles/{bottle_id}/location",
        json={"location_id": location["id"]},
    )
    assert placement.status_code == 200
    stocktake = post(client, "collection/stocktakes", {"name": "합성 복구 중단 실사"})
    scan_path = f"collection/stocktakes/{stocktake['id']}/scan"
    scanned = post(
        client,
        scan_path,
        {"bottle_code": f"sooljang:bottle:{bottle_id}", "observed_location_id": location["id"]},
        expected_status=200,
    )
    assert not scanned["duplicate"]
    post(
        client,
        f"collection/stocktakes/{stocktake['id']}/found",
        {"note": "합성 미등록 병"},
        expected_status=200,
    )
    paused = client.patch(
        f"{API_PREFIX}/collection/stocktakes/{stocktake['id']}", json={"status": "paused"}
    )
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused" and len(paused.json()["missing"]) == 1
    return [
        "collection/locations",
        "collection/bottles",
        f"collection/bottles/{bottle_id}/movements",
        "collection/stocktakes",
    ]


def api_records(client: TestClient, paths: list[str]) -> dict[str, Any]:
    result = {}
    for path in paths:
        response = client.get(f"{API_PREFIX}/{path}")
        assert response.status_code == 200, path
        result[path] = response.json()
    return result


def test_full_backup_restores_app_references_secrets_and_attachment(
    databases: tuple[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, target = databases
    # 어떤 어댑터가 transport 전달을 놓쳐도 실제 HTTP로 나갈 수 없게 한다.
    network = AsyncMock(side_effect=AssertionError("복구 검증에서 실제 HTTP는 허용하지 않습니다"))
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", network)
    source_uploads = Path(get_settings().upload_dir)
    source_uploads.mkdir(parents=True, exist_ok=True)
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
    )
    reset_rate_limiter()
    with TestClient(create_app()) as client:
        setup = post(
            client,
            "auth/setup",
            {
                "email": "recovery@example.com",
                "password": "recovery-synthetic-1234",
                "display_name": "복구 검증 합성 사용자",
            },
        )
        client.headers[CSRF_HEADER] = setup["csrf_token"]
        product = post(
            client, "products", {"name": "합성 복구 위스키", "skus": [{"volume_ml": 700}]}
        )
        purchase = post(
            client,
            "purchases",
            {
                "sku_id": product["skus"][0]["id"],
                "quantity": 2,
                "unit_list_price": "80000",
                "unit_paid_price": "60000",
            },
        )
        bottle = client.get(f"{API_PREFIX}/purchases/{purchase['id']}/bottles").json()[0]
        tasting = post(
            client,
            "tastings",
            {
                "bottle_id": bottle["id"],
                "tasted_on": "2026-09-07",
                "poured_ml": 30,
                "rating": "4.5",
            },
        )
        attachment = client.post(
            f"{API_PREFIX}/attachments",
            files={"file": ("synthetic.png", png, "image/png")},
            data={"kind": "label", "product_id": product["id"]},
        )
        assert attachment.status_code == 201
        attachment_id = attachment.json()["id"]
        original_content = client.get(f"{API_PREFIX}/attachments/{attachment_id}/content")
        assert original_content.status_code == 200 and original_content.content == png
        settings = client.put(
            f"{API_PREFIX}/llm-settings",
            json={
                "provider": "openai",
                "api_key": "synthetic-recovery-credential",
                "model": "gpt-4o-mini",
            },
        )
        assert settings.status_code == 200
        # 신규 가격 관측도 실제 덤프/복원으로 보존한다. 외부 HTTP는 합성 응답만 사용한다.
        from tests.infrastructure.external.test_offers import ITEMS, SPEC

        from sooljang.application import external_sources as external_application

        original_fetch = external_application.fetch_snapshot
        items = [{**item, "name": product["name"] + " 700ml"} for item in ITEMS]
        transport = httpx.MockTransport(
            lambda request: (
                httpx.Response(200, text="User-agent: *\nAllow: /")
                if request.url.path == "/robots.txt"
                else httpx.Response(200, json={"results": items})
            )
        )

        async def fixture_fetch(*args: Any, **kwargs: Any) -> Any:
            kwargs["transport"] = transport
            return await original_fetch(*args, **kwargs)

        monkeypatch.setattr(external_application, "fetch_snapshot", fixture_fetch)
        price_source = post(
            client,
            "external-sources",
            {
                "name": "합성 복구 가격",
                "base_url": "https://example.com",
                "adapter_spec": SPEC,
                "price_history_allowed": True,
            },
        )
        post(
            client,
            f"products/{product['id']}/external-matches",
            {
                "source_id": price_source["id"],
                "external_url": "https://example.com/item/1",
                "external_name": product["name"] + " 700ml",
                "external_key": "1",
            },
        )
        prices = post(client, f"products/{product['id']}/external-lookup", {}, expected_status=200)
        assert len(prices[0]["offers"]) == 3
        expected_prices = sorted(row["amount"] for row in prices[0]["offers"])
        paths = preserve_collection_fixture(client, bottle["id"])
        lease, subscription_id = prepare_delivery(client, API_PREFIX, monkeypatch)
        # settings cache가 source→target 전환되어도 같은 합성 VAPID를 사용한다.
        monkeypatch.setenv("SOOLJANG_PUSH_VAPID_PRIVATE_KEY", PRIVATE)
        monkeypatch.setenv("SOOLJANG_PUSH_VAPID_SUBJECT", "mailto:admin@example.com")

        async def expire_delivery_lease() -> None:
            async with get_session_factory().begin() as session:
                delivery = await session.get(PushDelivery, lease.delivery_id)
                assert delivery is not None and delivery.status == "sending"
                delivery.lease_until = datetime.now(UTC) - timedelta(seconds=1)

        run_async(client, expire_delivery_lease)
        paths += [
            "interests",
            "price-watch",
            "price-watch/notifications",
            "price-watch/subscriptions",
        ]
        expected_api = api_records(client, paths)
        watch = expected_api["price-watch"][0]
        assert expected_api["interests"][0]["source_matches"]
        assert watch["push_enabled"] and not watch["schedule_enabled"]
        assert expected_api["price-watch/notifications"][0]["delivery_states"] == ["sending"]
        assert expected_api["price-watch/subscriptions"][0]["id"] == subscription_id
        paths += [
            f"price-watch/interests/{watch['interest_id']}/history",
            f"price-watch/runs/{watch['latest_run']['id']}",
        ]
        expected_api = api_records(client, paths)
        expected_records = record_digests(source)
        assert expected_records["external_price_observation"][0] == 4
        expected_product = client.get(f"{API_PREFIX}/products/{product['id']}").json()
        assert client.get(f"{API_PREFIX}/health/ready").status_code == 200
        release_connections(client)
    bundle = recovery.create_backup(
        recovery.Database(source, local=True),
        tmp_path / "backups",
        source_uploads,
        writes_stopped=True,
        reserve=0,
    )
    # 읽을 수 있는 목차도 실제 데이터 복원 성공을 보장하지 않는다.
    damaged = tmp_path / "damaged"
    shutil.copytree(bundle, damaged)
    dump = damaged / "database.dump"
    payload = bytearray(dump.read_bytes())
    compressed_start = payload.index(b"\x78\x9c")
    payload[compressed_start + 8] ^= 0xFF
    dump.write_bytes(payload)
    manifest = json.loads((damaged / "manifest.json").read_text())
    manifest["database"].update({"sha256": recovery.digest(dump), "bytes": dump.stat().st_size})
    (damaged / "manifest.json").write_text(json.dumps(manifest))
    (damaged / "COMPLETE").write_text(recovery.digest(damaged / "manifest.json"))
    recovery.verify_bundle(damaged, recovery.Database(target, local=True))
    with pytest.raises(recovery.RecoveryError, match="pg_restore"):
        recovery.restore_backup(damaged, recovery.Database(target, local=True), tmp_path / "failed")
    recovery.Database(target, local=True).require_empty()
    restored_uploads = tmp_path / "restored-uploads"
    recovery.restore_backup(
        bundle, recovery.Database(target, local=True), restored_uploads, reserve=0
    )
    # 복원 후 앱이 원장을 읽거나 갱신하기 전에 암호문 포함 전 행을 대조한다.
    assert record_digests(target) == expected_records
    assert recovery.inventory(restored_uploads) == recovery.inventory(source_uploads)
    restored_image = next(restored_uploads.rglob("*.png")).read_bytes()
    assert restored_image == png and sniff_image_extension(restored_image) == ".png"
    monkeypatch.setenv("SOOLJANG_DATABASE_URL", url(target))
    monkeypatch.setenv("SOOLJANG_UPLOAD_DIR", str(restored_uploads))
    get_settings.cache_clear()
    reset_database_state()
    reset_rate_limiter()
    with TestClient(create_app()) as client:
        login(client)
        assert client.get(f"{API_PREFIX}/health/ready").status_code == 200
        assert api_records(client, paths) == expected_api

        async def verify_no_resend() -> None:
            async with get_session_factory()() as session:
                subscription = await session.scalar(
                    select(PushSubscription).where(
                        PushSubscription.id == uuid.UUID(subscription_id)
                    )
                )
                assert subscription is not None and subscription.subscription_ciphertext is not None
                # backup/restore의 전체 암호문 검사와 별도로 앱 프로세스에서도 복호화한다.
                assert isinstance(
                    json.loads(
                        recovery.key_from_environment().decrypt(
                            subscription.subscription_ciphertext
                        )
                    ),
                    dict,
                )
            assert await worker_tick(get_settings()) == {"enqueued": 0, "runs": 0, "deliveries": 0}
            assert await worker_tick(get_settings()) == {"enqueued": 0, "runs": 0, "deliveries": 0}
            async with get_session_factory().begin() as session:
                delivery = await session.get(PushDelivery, lease.delivery_id)
                assert delivery is not None
                assert delivery.status == "unknown" and delivery.attempts == 1
                assert (
                    await claim_delivery(session, now=datetime.now(UTC) + timedelta(days=1)) is None
                )

        from sooljang.application import price_watch_worker

        send = AsyncMock(side_effect=AssertionError("복구한 불확실한 전송을 다시 보내면 안 됩니다"))
        monkeypatch.setattr(price_watch_worker, "send_push", send)
        run_async(client, verify_no_resend)
        send.assert_not_called()
        notices = client.get(f"{API_PREFIX}/price-watch/notifications").json()
        assert len(notices) == 1 and notices[0]["delivery_states"] == ["unknown"]
        assert notices[0]["id"] == expected_api["price-watch/notifications"][0]["id"]
        for table, record in record_digests(target).items():
            if table != "push_delivery":
                assert record == expected_records[table], table
        restored_content = client.get(f"{API_PREFIX}/attachments/{attachment_id}/content")
        assert restored_content.status_code == 200 and restored_content.content == png
        assert restored_content.headers["content-type"] == "image/png"
        assert restored_content.headers["cache-control"] == "private, no-store"
        assert restored_content.headers["x-content-type-options"] == "nosniff"
        metadata = client.get(
            f"{API_PREFIX}/attachments", params={"product_id": product["id"]}
        ).json()
        assert len(metadata) == 1 and metadata[0]["id"] == attachment_id
        actual_product = client.get(f"{API_PREFIX}/products/{product['id']}").json()
        assert actual_product == expected_product
        assert actual_product["metrics"]["purchased_count"] == 2
        assert actual_product["metrics"]["avg_paid_price"] == "60000.00"
        assert client.get(f"{API_PREFIX}/bottles/{bottle['id']}").json()["remaining_ml"] == 670
        timeline = client.get(f"{API_PREFIX}/tastings", params={"bottle_id": bottle["id"]}).json()
        assert timeline[0]["id"] == tasting["id"] and timeline[0]["rating"] == "4.5"
        assert client.get(f"{API_PREFIX}/llm-settings").json()["configured"] is True
        restored_prices = post(
            client, f"products/{product['id']}/external-lookup", {}, expected_status=200
        )
        restored_price = next(
            result for result in restored_prices if result["source_id"] == price_source["id"]
        )
        assert restored_price["cached"] is True
        assert sorted(row["amount"] for row in restored_price["offers"]) == expected_prices
        assert restored_price["pinned"] is True
        release_connections(client)
    with psycopg.connect(dbname=target) as connection:
        # pg_restore가 FK를 설치/검증했다. 임의의 잘못된 참조도 허용되지 않는다.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            connection.execute(
                "UPDATE bottle SET purchase_id='00000000-0000-0000-0000-000000000000'"
            )
        connection.rollback()
        # 실패한 스키마 변경은 원래 리비전·새 사용자 데이터를 보존한다.
        before = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        with pytest.raises(psycopg.errors.DivisionByZero), connection.transaction():
            connection.execute("UPDATE alembic_version SET version_num='failed_migration'")
            connection.execute("SELECT 1 / 0")
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == before
        assert connection.execute("SELECT count(*) FROM purchase").fetchone() == (1,)
        assert connection.execute("SELECT count(*) FROM external_price_observation").fetchone() == (
            4,
        )
    network.assert_not_called()
