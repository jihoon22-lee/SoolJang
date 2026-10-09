"""병별 조건부 변경을 위한 revision. 기존 데이터와 기록은 보존한다."""

import sqlalchemy as sa
from alembic import op

revision = "0020_bottle_revision"
down_revision = "0019_record_event"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bottle",
        sa.Column(
            "revision", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")
        ),
    )
    op.alter_column("bottle", "revision", server_default=None)


def downgrade() -> None:
    op.drop_column("bottle", "revision")
