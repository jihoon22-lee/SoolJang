"""0019 변경 이력 테이블은 기존 구매·병·시음을 바꾸지 않고 추가·제거된다."""

import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from sooljang.config import get_settings

pytestmark = pytest.mark.requires_db


def test_record_event_upgrade_and_downgrade_preserve_existing_records() -> None:
    url = sa.make_url(str(get_settings().database_url))
    assert url.database and url.database.endswith("_test")
    engine = sa.create_engine(url.set(drivername="postgresql+psycopg"))
    config = Config("alembic.ini")
    user, product, sku, purchase, bottle = (uuid.uuid4() for _ in range(5))
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP SCHEMA public CASCADE")
            connection.exec_driver_sql("CREATE SCHEMA public")
        command.upgrade(config, "0018_price_watch")
        with engine.begin() as connection:
            connection.execute(
                sa.text(
                    "INSERT INTO product (id, user_id, name, normalized_name)"
                    " VALUES (:p, :u, '보존 술', '보존술')"
                ),
                {"p": product, "u": user},
            )
            connection.execute(
                sa.text(
                    "INSERT INTO sku (id, user_id, product_id, volume_ml) VALUES (:s, :u, :p, 700)"
                ),
                {"s": sku, "u": user, "p": product},
            )
            connection.execute(
                sa.text(
                    "INSERT INTO purchase"
                    " (id, user_id, sku_id, quantity, currency, unit_paid_price)"
                    " VALUES (:pu, :u, :s, 1, 'KRW', 12345)"
                ),
                {"pu": purchase, "u": user, "s": sku},
            )
            connection.execute(
                sa.text(
                    "INSERT INTO bottle (id, user_id, purchase_id, label_no, status, remaining_ml)"
                    " VALUES (:b, :u, :pu, 1, 'open', 321)"
                ),
                {"b": bottle, "u": user, "pu": purchase},
            )

        command.upgrade(config, "0019_record_event")
        command.downgrade(config, "0018_price_watch")
        command.upgrade(config, "0019_record_event")

        with engine.connect() as connection:
            row = connection.execute(
                sa.text(
                    "SELECT b.status, b.remaining_ml, p.unit_paid_price FROM bottle b"
                    " JOIN purchase p ON p.id = b.purchase_id WHERE b.id = :b"
                ),
                {"b": bottle},
            ).one()
            events = connection.execute(sa.text("SELECT count(*) FROM record_event")).scalar()
        assert (row.status, row.remaining_ml, int(row.unit_paid_price)) == ("open", 321, 12345)
        # 과거 이력을 소급해 만들지 않는다.
        assert events == 0
    finally:
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP SCHEMA public CASCADE")
            connection.exec_driver_sql("CREATE SCHEMA public")
        engine.dispose()
