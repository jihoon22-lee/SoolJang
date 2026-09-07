"""외부 제품 고정·판매 조건·실제 가격 관측의 additive 저장 계약."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015_external_offers"
down_revision: str | None = "0014_provider_connections"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 기존 고정 URL/key/override와 암호문은 보존한다. 제품 key는 원래 판매 항목의
    # 실제 응답 또는 명시적 사용자 확인으로만 연결하며 이름으로 backfill하지 않는다.
    op.add_column(
        "external_product_match", sa.Column("external_product_key", sa.Text(), nullable=True)
    )
    op.add_column(
        "external_product_match", sa.Column("preferred_seller_key", sa.Text(), nullable=True)
    )
    op.add_column(
        "external_source",
        sa.Column("price_history_allowed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("external_source", "price_history_allowed", server_default=None)
    op.create_table(
        "external_offer",
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
        sa.Column("source_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("external_product_key", sa.Text(), nullable=False),
        sa.Column("external_offer_key", sa.Text(), nullable=False),
        sa.Column("condition_key", sa.String(64), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["source_id"], ["external_source.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["product.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_external_offer_user_id", "external_offer", ["user_id"])
    op.create_index("ix_external_offer_user_product", "external_offer", ["user_id", "product_id"])
    op.create_index(
        "uq_external_offer_condition",
        "external_offer",
        ["source_id", "product_id", "condition_key"],
        unique=True,
    )
    op.create_table(
        "external_price_observation",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("offer_id", sa.UUID(), nullable=False),
        sa.Column("amount", sa.Numeric(18, 4), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("facts", postgresql.JSONB(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["offer_id"], ["external_offer.id"], ondelete="CASCADE"),
        sa.CheckConstraint("amount >= 0", name="nonnegative_amount"),
    )
    op.create_index(
        "uq_external_price_acquisition",
        "external_price_observation",
        ["offer_id", "fetched_at"],
        unique=True,
    )
    op.create_index(
        "ix_external_price_user_time", "external_price_observation", ["user_id", "fetched_at"]
    )


def downgrade() -> None:
    op.drop_table("external_price_observation")
    op.drop_table("external_offer")
    op.drop_column("external_source", "price_history_allowed")
    op.drop_column("external_product_match", "preferred_seller_key")
    op.drop_column("external_product_match", "external_product_key")
