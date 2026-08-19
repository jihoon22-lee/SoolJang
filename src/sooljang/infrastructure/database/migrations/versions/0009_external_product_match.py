"""external_product_match

`external_product_match`("이 제품 = 이 소스의 이 URL" 고정)를 추가한다(Task 34 PR1, §7.4).

Revision ID: 0009_external_product_match
Revises: 757982c7b323
Create Date: 2026-08-19 17:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_external_product_match"
down_revision: str | None = "757982c7b323"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "external_product_match",
        sa.Column("source_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("external_url", sa.Text(), nullable=False),
        sa.Column("external_name", sa.Text(), nullable=False),
        sa.Column("external_key", sa.String(length=200), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["product.id"],
            name=op.f("fk_external_product_match_product_id_product"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["external_source.id"],
            name=op.f("fk_external_product_match_source_id_external_source"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_external_product_match")),
    )
    op.create_index(
        op.f("ix_external_product_match_user_id"),
        "external_product_match",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_external_product_match_user_id_product_id",
        "external_product_match",
        ["user_id", "product_id"],
        unique=False,
    )
    op.create_index(
        "uq_external_product_match_identity",
        "external_product_match",
        ["source_id", "product_id"],
        unique=True,
        postgresql_where="deleted_at IS NULL",
    )


def downgrade() -> None:
    op.drop_index(
        "uq_external_product_match_identity",
        table_name="external_product_match",
        postgresql_where="deleted_at IS NULL",
    )
    op.drop_index(
        "ix_external_product_match_user_id_product_id", table_name="external_product_match"
    )
    op.drop_index(op.f("ix_external_product_match_user_id"), table_name="external_product_match")
    op.drop_table("external_product_match")
