"""관심 구매 전환·정리 영향·병 위치와 실사 기록을 추가한다.

기존 구매·병·시음·자유 입력 위치·관심·가격 관측을 수정하지 않는다.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017_data_inventory"
down_revision: str | None = "0016_discovery_interest"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _common() -> list[sa.Column]:
    return [
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade() -> None:
    op.create_table(
        "storage_location",
        *_common(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_storage_location"),
    )
    op.create_table(
        "bottle_placement",
        *_common(),
        sa.Column("bottle_id", sa.UUID(), nullable=False),
        sa.Column("location_id", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["bottle_id"], ["bottle.id"], name="fk_bottle_placement_bottle_id_bottle"
        ),
        sa.ForeignKeyConstraint(
            ["location_id"],
            ["storage_location.id"],
            name="fk_bottle_placement_location_id_storage_location",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_bottle_placement"),
        sa.UniqueConstraint("bottle_id", name="uq_bottle_placement_bottle_id"),
    )
    op.create_table(
        "bottle_movement",
        *_common(),
        sa.Column("bottle_id", sa.UUID(), nullable=False),
        sa.Column("from_location_id", sa.UUID(), nullable=True),
        sa.Column("to_location_id", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["bottle_id"], ["bottle.id"], name="fk_bottle_movement_bottle_id_bottle"
        ),
        sa.ForeignKeyConstraint(
            ["from_location_id"],
            ["storage_location.id"],
            name="fk_bottle_movement_from_location_id_storage_location",
        ),
        sa.ForeignKeyConstraint(
            ["to_location_id"],
            ["storage_location.id"],
            name="fk_bottle_movement_to_location_id_storage_location",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_bottle_movement"),
    )
    op.create_table(
        "stocktake",
        *_common(),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("location_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("expected", postgresql.JSONB(), nullable=False),
        sa.Column("observations", postgresql.JSONB(), nullable=False),
        sa.Column("found_notes", postgresql.JSONB(), nullable=False),
        sa.ForeignKeyConstraint(
            ["location_id"],
            ["storage_location.id"],
            name="fk_stocktake_location_id_storage_location",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_stocktake"),
    )
    op.create_table(
        "cleanup_preview",
        *_common(),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("selection", postgresql.JSONB(), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_cleanup_preview"),
    )
    op.create_table(
        "interest_conversion",
        *_common(),
        sa.Column("interest_id", sa.UUID(), nullable=False),
        sa.Column("purchase_id", sa.UUID(), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(
            ["interest_id"], ["interest.id"], name="fk_interest_conversion_interest_id_interest"
        ),
        sa.ForeignKeyConstraint(
            ["purchase_id"], ["purchase.id"], name="fk_interest_conversion_purchase_id_purchase"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_interest_conversion"),
        sa.UniqueConstraint("interest_id", name="uq_interest_conversion_interest_id"),
    )
    for table in (
        "storage_location",
        "bottle_placement",
        "bottle_movement",
        "stocktake",
        "cleanup_preview",
        "interest_conversion",
    ):
        op.create_index(f"ix_{table}_user_id", table, ["user_id"])


def downgrade() -> None:
    for table in (
        "interest_conversion",
        "cleanup_preview",
        "stocktake",
        "bottle_movement",
        "bottle_placement",
        "storage_location",
    ):
        op.drop_index(f"ix_{table}_user_id", table_name=table)
        op.drop_table(table)
