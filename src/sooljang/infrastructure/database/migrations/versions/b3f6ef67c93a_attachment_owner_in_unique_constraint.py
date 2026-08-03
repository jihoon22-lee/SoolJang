"""attachment_owner_in_unique_constraint

Revision ID: b3f6ef67c93a
Revises: 0008_external_sources
Create Date: 2026-08-03 22:33:38.516461

첨부 중복 제거를 `(user_id, sha256, kind)` 로만 판단하면 소유 대상(product_id/bottle_id/
tasting_session_id)을 무시한다 — 같은 사진을 다른 제품에 붙이면 앞서 만든 첨부가 그대로
반환돼 새 제품엔 안 붙는 결함이었다(`api/routes/attachments.py` 조회 쿼리도 함께 고침).
PostgreSQL 은 UNIQUE 제약에서 NULL 을 서로 다른 값으로 보므로, 소유자 세 컬럼을 제약에
추가해도 "정확히 하나만 채운다"는 CHECK 제약과 함께라면 실제 소유자가 다른 행끼리는
충돌하지 않는다.

`autogenerate` 가 이 세션의 테스트 DB에 남아 있던 무관한 `sample_entity` 테이블(다른
테스트 픽스처의 임시 산물)도 diff 로 잡아냈다 — 그 부분은 이 마이그레이션과 무관해 손으로
지웠다.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b3f6ef67c93a"
down_revision: str | None = "0008_external_sources"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("uq_attachment_user_sha256_kind"), "attachment", type_="unique")
    op.create_unique_constraint(
        "uq_attachment_user_sha256_kind_owner",
        "attachment",
        ["user_id", "sha256", "kind", "product_id", "bottle_id", "tasting_session_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_attachment_user_sha256_kind_owner", "attachment", type_="unique")
    op.create_unique_constraint(
        op.f("uq_attachment_user_sha256_kind"),
        "attachment",
        ["user_id", "sha256", "kind"],
        postgresql_nulls_not_distinct=False,
    )
