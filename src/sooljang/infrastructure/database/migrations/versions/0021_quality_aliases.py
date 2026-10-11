"""확인한 검색 별칭과 관심 출처 URL. 기존 이름·구매·시음·암호문은 보존한다."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0021_quality_aliases"
down_revision = "0020_bottle_revision"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table, field in (("product", "search_aliases"), ("interest", "reference_urls")):
        op.add_column(
            table, sa.Column(field, JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb"))
        )
        op.alter_column(table, field, server_default=None)


def downgrade() -> None:
    op.drop_column("interest", "reference_urls")
    op.drop_column("product", "search_aliases")
