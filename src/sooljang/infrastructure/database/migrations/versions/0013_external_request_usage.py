"""외부 요청 예약과 설정 revision별 검증 기록.

Revision ID: 0013_external_request_usage
Revises: 0012_llm_rematch
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_external_request_usage"
down_revision: str | None = "0012_llm_rematch"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table, column, default in (
        ("external_source", "config_revision", "1"),
        ("external_source", "request_limit_per_day", "1000"),
        ("external_source_probe", "config_revision", "0"),
    ):
        op.add_column(
            table, sa.Column(column, sa.Integer(), nullable=False, server_default=default)
        )
        op.alter_column(table, column, server_default=None)
    op.add_column(
        "external_source_probe",
        sa.Column("outcome", sa.String(32), nullable=False, server_default="unknown"),
    )
    op.alter_column("external_source_probe", "outcome", server_default=None)
    op.create_table(
        "external_request_usage",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("scope_kind", sa.String(20), nullable=False),
        sa.Column("scope_id", sa.UUID(), nullable=False),
        sa.Column("window_kind", sa.String(10), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reserved_count", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint(
            "user_id",
            "scope_kind",
            "scope_id",
            "window_kind",
            "window_start",
            name="pk_external_request_usage",
        ),
        sa.CheckConstraint("scope_kind IN ('source', 'connection')", name="valid_scope"),
        sa.CheckConstraint("window_kind IN ('minute', 'day')", name="valid_window"),
        sa.CheckConstraint("reserved_count >= 0", name="nonnegative_count"),
    )


def downgrade() -> None:
    op.drop_table("external_request_usage")
    op.drop_column("external_source_probe", "outcome")
    op.drop_column("external_source_probe", "config_revision")
    op.drop_column("external_source", "request_limit_per_day")
    op.drop_column("external_source", "config_revision")
