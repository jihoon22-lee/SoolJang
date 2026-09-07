"""구매와 분리한 관심 identity 및 기존 외부 관측/캐시의 관심 참조."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0016_discovery_interest"
down_revision: str | None = "0015_external_offers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "interest",
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
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("identity", JSONB(), nullable=False),
        sa.Column("source_matches", JSONB(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("product_id", sa.UUID(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["product_id"], ["product.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_interest_user_id", "interest", ["user_id"])
    for table in ("external_offer", "external_lookup_cache"):
        op.add_column(table, sa.Column("interest_id", sa.UUID(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_interest_id_interest",
            table,
            "interest",
            ["interest_id"],
            ["id"],
            ondelete="CASCADE",
        )
        op.alter_column(table, "product_id", nullable=True)
    for table in ("external_offer", "external_lookup_cache"):
        op.create_check_constraint(
            "one_lookup_target", table, "(product_id IS NULL) <> (interest_id IS NULL)"
        )
    op.create_index(
        "ix_external_lookup_cache_interest",
        "external_lookup_cache",
        ["source_id", "interest_id", "fetched_at"],
    )
    op.create_index(
        "uq_external_offer_interest_condition",
        "external_offer",
        ["source_id", "interest_id", "condition_key"],
        unique=True,
    )


def downgrade() -> None:
    # 신규 관심 자료는 구 스키마로 표현할 수 없다. 운영에서는 자동 downgrade하지 않는다.
    op.execute("DELETE FROM external_lookup_cache WHERE product_id IS NULL")
    op.execute("DELETE FROM external_offer WHERE product_id IS NULL")
    op.drop_index("uq_external_offer_interest_condition", table_name="external_offer")
    op.drop_index("ix_external_lookup_cache_interest", table_name="external_lookup_cache")
    for table in ("external_offer", "external_lookup_cache"):
        op.drop_constraint(op.f(f"ck_{table}_one_lookup_target"), table, type_="check")
    for table in ("external_offer", "external_lookup_cache"):
        op.drop_constraint(f"fk_{table}_interest_id_interest", table, type_="foreignkey")
        op.drop_column(table, "interest_id")
        op.alter_column(table, "product_id", nullable=False)
    op.drop_table("interest")
