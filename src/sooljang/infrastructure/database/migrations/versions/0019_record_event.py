"""병 상태 전이·구매 수정의 변경 이력(record_event).

Revision ID: 0019_record_event
Revises: 0018_price_watch

새 테이블만 추가한다(additive). 기존 구매·병·시음 행은 바꾸지 않으며 과거 이력을
소급해 만들지 않는다. downgrade 는 이후 쌓인 이력만 잃는다 — 운영에서는 같은 이미지·
스키마의 검증된 백업으로 복구한다.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0019_record_event"
down_revision = "0018_price_watch"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "record_event",
        sa.Column("entity", sa.String(length=24), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_record_event")),
    )
    op.create_index(
        "ix_record_event_entity",
        "record_event",
        ["user_id", "entity", "entity_id", "created_at"],
        unique=False,
    )
    op.create_index(op.f("ix_record_event_user_id"), "record_event", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_record_event_user_id"), table_name="record_event")
    op.drop_index("ix_record_event_entity", table_name="record_event")
    op.drop_table("record_event")
