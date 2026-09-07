"""Opt-in PostgreSQL 복원: 합성 앱 데이터만, 명시된 recovery_test DB만 사용한다.

환경 변수(값을 기록하지 않음): SOOLJANG_RUN_RECOVERY_TESTS,
SOOLJANG_RECOVERY_TEST_SOURCE, PGHOST, PGPORT, PGUSER, SOOLJANG_PG_BIN.
별도 *_restored DB를 생성·제거하므로 일반 CI/로컬 실행에서는 자동 실행하지 않는다.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from psycopg import sql
from test_recovery import recovery

from sooljang.api.app import API_PREFIX, create_app
from sooljang.api.routes.auth import CSRF_HEADER
from sooljang.application.auth import reset_rate_limiter
from sooljang.config import get_settings
from sooljang.infrastructure.database.session import get_engine, reset_database_state
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


def test_full_backup_restores_app_references_secrets_and_attachment(
    databases: tuple[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, target = databases
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
        import httpx
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
        assert restored_prices[0]["cached"] is True
        assert sorted(row["amount"] for row in restored_prices[0]["offers"]) == expected_prices
        assert restored_prices[0]["pinned"] is True
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
            3,
        )
