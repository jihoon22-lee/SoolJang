"""pg_trgm 확장 활성화

한글은 형태소 분석기 없이 부분 문자열 검색을 해야 한다. pg_trgm GIN 인덱스가
`ILIKE '%...%'` 를 가속하는 것을 실측으로 확인했으므로(Bitmap Index Scan),
스키마의 첫 전제로 확장을 만든다.

Revision ID: 0001_enable_pg_trgm
Revises:
Create Date: 2026-07-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001_enable_pg_trgm"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")


def downgrade() -> None:
    # 다른 객체가 확장에 의존할 수 있으므로 CASCADE 를 쓰지 않는다. 의존 객체가
    # 남아 있으면 실패하는 것이 조용히 인덱스를 지우는 것보다 안전하다.
    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
