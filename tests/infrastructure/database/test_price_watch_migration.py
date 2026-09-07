"""0017 관심/관측을 보존하는 0018 왕복 및 중간 DDL 실패의 트랜잭션 rollback."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
import sqlalchemy as sa
from alembic import command, op
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy.orm import Session

from sooljang.config import get_settings
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.models import (
    ExternalOffer,
    ExternalPriceObservation,
    ExternalSource,
    Interest,
)

pytestmark = pytest.mark.requires_db
NEW_TABLES = {
    "price_watch",
    "price_watch_run",
    "price_notification",
    "push_subscription",
    "push_delivery",
}


def test_additive_upgrade_failure_and_repeated_migration_preserve_interest_and_observation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = sa.make_url(str(get_settings().database_url))
    assert url.database and url.database.endswith("_test")
    engine = sa.create_engine(url.set(drivername="postgresql+psycopg"))
    config = Config("alembic.ini")
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP SCHEMA public CASCADE")
            connection.exec_driver_sql("CREATE SCHEMA public")
        command.upgrade(config, "0017_data_inventory")
        user = uuid.uuid4()
        now = datetime.now(UTC)
        observation_id = uuid.uuid4()
        with Session(engine) as session:
            source = ExternalSource(
                user_id=user,
                name="이전 보존",
                base_url="https://example.com",
                adapter_spec={},
                price_history_allowed=True,
            )
            session.add(source)
            session.flush()
            interest = Interest(
                user_id=user,
                name="보존 관심",
                identity={"name": "보존 관심"},
                source_matches={
                    str(source.id): {
                        "product_key": "p",
                        "external_url": "https://example.com/p",
                        "external_key": "o",
                        "external_name": "보존 관심",
                    }
                },
                note="사용자 노트 보존",
            )
            session.add(interest)
            session.flush()
            offer = ExternalOffer(
                user_id=user,
                source_id=source.id,
                product_id=None,
                interest_id=interest.id,
                external_product_key="p",
                external_offer_key="o",
                condition_key="a" * 64,
                last_seen_at=now,
            )
            session.add(offer)
            session.flush()
            session.add(
                ExternalPriceObservation(
                    id=observation_id,
                    user_id=user,
                    offer_id=offer.id,
                    amount=Decimal(12345),
                    currency="KRW",
                    source_url="https://example.com/p",
                    fetched_at=now,
                    facts={"in_stock": True},
                )
            )
            session.commit()
        original = op.create_table

        def fail_after_some_tables(name: str, *args: Any, **kwargs: Any) -> Any:
            if name == "price_notification":
                raise RuntimeError("synthetic interrupted watch migration")
            return original(name, *args, **kwargs)

        with monkeypatch.context() as patch:
            patch.setattr(op, "create_table", fail_after_some_tables)
            with pytest.raises(RuntimeError, match="synthetic interrupted"):
                command.upgrade(config, "head")
        with engine.connect() as connection:
            assert not NEW_TABLES.intersection(sa.inspect(connection).get_table_names())
            assert (
                connection.execute(sa.text("SELECT note FROM interest")).scalar()
                == "사용자 노트 보존"
            )
        for roundtrip in range(2):
            command.upgrade(config, "head")
            with engine.connect() as connection:
                assert set(sa.inspect(connection).get_table_names()) >= NEW_TABLES
                observation = connection.execute(
                    sa.text("SELECT id,amount,currency,fetched_at FROM external_price_observation")
                ).one()
                assert tuple(observation) == (observation_id, Decimal(12345), "KRW", now)
                assert connection.execute(sa.text("SELECT count(*) FROM price_watch")).scalar() == 0
                production = sa.MetaData(naming_convention=Base.metadata.naming_convention)
                for mapper in Base.registry.mappers:
                    if mapper.class_.__module__.startswith("sooljang.") and isinstance(
                        mapper.local_table, sa.Table
                    ):
                        mapper.local_table.to_metadata(production)
                assert compare_metadata(MigrationContext.configure(connection), production) == []
            if roundtrip == 0:
                command.downgrade(config, "0017_data_inventory")
    finally:
        engine.dispose()
