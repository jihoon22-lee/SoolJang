"""0013 사용자 설정의 opaque 암호문 보존과 결정적인 0014 재적용."""

import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext

from sooljang.config import get_settings
from sooljang.infrastructure.database.base import Base

pytestmark = pytest.mark.requires_db


def test_upgrade_preserves_distinct_profiles_ciphertexts_and_source_overrides() -> None:
    url = sa.make_url(str(get_settings().database_url))
    assert url.database is not None and url.database.endswith("_test")
    engine = sa.create_engine(url.set(drivername="postgresql+psycopg"))
    config = Config("alembic.ini")
    owner = uuid.uuid4()
    source_ids = [uuid.uuid4(), uuid.uuid4()]
    llm_id = uuid.uuid4()
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP SCHEMA public CASCADE")
            connection.exec_driver_sql("CREATE SCHEMA public")
        command.upgrade(config, "0013_external_request_usage")
        legacy = sa.MetaData()
        legacy.reflect(
            bind=engine, only=["external_source", "external_source_credential", "llm_setting"]
        )
        with engine.begin() as connection:
            for index, source_id in enumerate(source_ids):
                connection.execute(
                    legacy.tables["external_source"]
                    .insert()
                    .values(
                        id=source_id,
                        user_id=owner,
                        name=f"보존 {index}",
                        base_url="https://example.com",
                        adapter_spec={"credentials": [{"name": "api_key"}], "override": "preserve"},
                        priority=index,
                        is_active=index == 0,
                        rate_limit_per_min=6,
                        ttl_hours=12,
                        spec_overridden=True,
                        config_revision=4,
                        request_limit_per_day=500,
                    )
                )
                connection.execute(
                    legacy.tables["external_source_credential"]
                    .insert()
                    .values(
                        id=uuid.uuid4(),
                        user_id=owner,
                        source_id=source_id,
                        name="api_key",
                        secret_ciphertext=f"opaque-{index}".encode(),
                        hint="same",
                    )
                )
            connection.execute(
                legacy.tables["llm_setting"]
                .insert()
                .values(
                    id=llm_id,
                    user_id=owner,
                    provider="openai",
                    api_key_ciphertext=b"opaque-ocr",
                    api_key_hint="same",
                    model="preserved-model",
                    rematch_enabled=True,
                    rematch_monthly_cap=41,
                )
            )
        expected = {
            uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:source:{item}") for item in source_ids
        }
        expected.add(uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:llm:{llm_id}"))
        for roundtrip in range(2):
            command.upgrade(config, "head")
            with engine.connect() as connection:
                assert (
                    set(connection.execute(sa.text("SELECT id FROM provider_connection")).scalars())
                    == expected
                )
                rows = connection.execute(
                    sa.text("SELECT secret_ciphertext, hint FROM provider_credential")
                ).all()
                assert {(bytes(row[0]), row[1]) for row in rows} == {
                    (b"opaque-0", "same"),
                    (b"opaque-1", "same"),
                    (b"opaque-ocr", "same"),
                }
                originals = connection.execute(
                    sa.text(
                        "SELECT spec_overridden, adapter_spec, config_revision FROM external_source"
                    )
                ).all()
                assert all(
                    row[0] and row[1]["override"] == "preserve" and row[2] == 4 for row in originals
                )
                llm = connection.execute(
                    sa.text(
                        "SELECT model, rematch_enabled, rematch_monthly_cap, "
                        "api_key_ciphertext FROM llm_setting"
                    )
                ).one()
                assert tuple(llm) == ("preserved-model", True, 41, b"opaque-ocr")
                assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
            if roundtrip == 0:
                command.downgrade(config, "0013_external_request_usage")
    finally:
        engine.dispose()
