"""폐기 가능한 B08 브라우저 DB에서만 additive migration과 기존 사실 보존을 확인한다."""

import datetime
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
from cryptography.fernet import Fernet
from psycopg import sql
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from sooljang.infrastructure.database.models import (
    Bottle,
    ExternalOffer,
    ExternalPriceObservation,
    ExternalSource,
    Interest,
    Product,
    Purchase,
    Sku,
    TastingSession,
    Vendor,
)

ROOT = Path(__file__).resolve().parents[2]
DB_NAME = "sooljang_inventory_browser_test"
URL = f"postgresql+psycopg://sooljang@127.0.0.1:54329/{DB_NAME}"
ENV = dict(
    os.environ,
    SOOLJANG_ENV_FILE="",
    SOOLJANG_ENVIRONMENT="test",
    SOOLJANG_DATABASE_URL=URL,
    SOOLJANG_SECRET_KEY=Fernet.generate_key().decode(),
)


def alembic(*args: str) -> None:
    subprocess.run([str(ROOT / ".venv/bin/alembic"), *args], cwd=ROOT, env=ENV, check=True)


def snapshot() -> dict[str, object]:
    with psycopg.connect(host="127.0.0.1", port=54329, user="sooljang", dbname=DB_NAME) as conn:
        tables = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public'"
        ).fetchall()
        return {
            name: conn.execute(
                sql.SQL("SELECT to_jsonb(t) FROM {} t ORDER BY to_jsonb(t)::text").format(
                    sql.Identifier(name)
                )
            ).fetchall()
            for (name,) in tables
            if name != "alembic_version"
        }


with psycopg.connect(
    host="127.0.0.1", port=54329, user="sooljang", dbname=DB_NAME, autocommit=True
) as conn:
    target = conn.execute("SELECT current_database()").fetchone()
    assert target is not None and target[0] == DB_NAME
    conn.execute("DROP SCHEMA public CASCADE")
    conn.execute("CREATE SCHEMA public")
alembic("upgrade", "0016_discovery_interest")


owner = uuid.uuid4()
with Session(create_engine(URL)) as session:
    vendor = Vendor(user_id=owner, name="이전 구매처")
    product = Product(user_id=owner, name="이전 제품", normalized_name="이전제품")
    source = ExternalSource(
        user_id=owner, name="이전 출처", base_url="https://example.com", adapter_spec={}
    )
    session.add_all([vendor, product, source])
    session.flush()
    sku = Sku(user_id=owner, product_id=product.id, volume_ml=700)
    session.add(sku)
    session.flush()
    purchase = Purchase(
        user_id=owner, sku_id=sku.id, vendor_id=vendor.id, quantity=2, unit_paid_price="1250.50"
    )
    session.add(purchase)
    session.flush()
    bottle = Bottle(user_id=owner, purchase_id=purchase.id, storage_location="이전 자유 입력 위치")
    interest = Interest(
        user_id=owner,
        name="이전 관심",
        identity={"name": "이전 관심"},
        source_matches={
            str(source.id): {
                "external_url": "https://example.com/p",
                "external_name": "합성 외부 이름",
                "external_key": "p",
                "product_key": None,
            }
        },
    )
    session.add_all([bottle, interest])
    session.flush()
    tasting = TastingSession(
        user_id=owner,
        bottle_id=bottle.id,
        sku_id=sku.id,
        tasted_on=datetime.date(2026, 9, 7),
        note="이전 시음 메모",
    )
    offer = ExternalOffer(
        user_id=owner,
        source_id=source.id,
        interest_id=interest.id,
        product_id=None,
        external_product_key="p",
        external_offer_key="o",
        condition_key="condition",
        last_seen_at=datetime.datetime.now(datetime.UTC),
    )
    session.add_all([tasting, offer])
    session.flush()
    session.add(
        ExternalPriceObservation(
            id=uuid.uuid4(),
            user_id=owner,
            offer_id=offer.id,
            amount="1350",
            currency="KRW",
            source_url="https://example.com/p",
            fetched_at=datetime.datetime.now(datetime.UTC),
            facts={"synthetic": True},
        )
    )
    session.commit()
before = snapshot()
alembic("upgrade", "head")
alembic("check")
after = snapshot()
assert all(after[name] == rows for name, rows in before.items())
assert set(after) - set(before) == {
    "storage_location",
    "bottle_placement",
    "bottle_movement",
    "stocktake",
    "cleanup_preview",
    "interest_conversion",
}
alembic("downgrade", "0016_discovery_interest")
assert snapshot() == before
alembic("upgrade", "head")
alembic("check")
assert all(snapshot()[name] == rows for name, rows in before.items())
print(
    "PASS: 0016 → 0017 → 0016 → 0017; drift 없음; 기존 구매·병·시음·관심·출처 고정·가격 관측 보존"
)
