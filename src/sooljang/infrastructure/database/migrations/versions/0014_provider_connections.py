"""통합 연결과 암호문을 추가하고 기존 프로필을 각각 보존한다.

Revision ID: 0014_provider_connections
Revises: 0013_external_request_usage

마스터 키 없이 opaque ciphertext를 그대로 복사한다. suffix로 중복 제거하지 않는다.
원본 source·LLM·사용자 고정/override는 삭제하지 않는다. 운영 downgrade는 새 연결을 잃으므로
사전 백업·격리 복구 없이 실행하지 않는다.
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_provider_connections"
down_revision: str | None = "0013_external_request_usage"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _identity_columns() -> list[sa.Column]:
    return [
        sa.Column("id", sa.UUID(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade() -> None:
    connections = op.create_table(
        "provider_connection",
        *_identity_columns(),
        sa.Column("provider_kind", sa.String(32), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("config_revision", sa.Integer(), nullable=False),
        sa.Column("rate_limit_per_min", sa.Integer(), nullable=False),
        sa.Column("request_limit_per_day", sa.Integer(), nullable=False),
        sa.Column("required_fields", postgresql.JSONB(), nullable=False),
        sa.Column("origin_kind", sa.String(16), nullable=False),
        sa.Column("origin_id", sa.UUID(), nullable=True),
        sa.Column("verified_revision", sa.Integer(), nullable=True),
        sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_outcome", sa.String(32), nullable=False),
        sa.UniqueConstraint(
            "user_id", "origin_kind", "origin_id", name="uq_provider_connection_origin"
        ),
        sa.CheckConstraint("config_revision >= 1", name="positive_revision"),
        sa.CheckConstraint(
            "rate_limit_per_min >= 1 AND request_limit_per_day >= 1", name="positive_limits"
        ),
    )
    op.create_index("ix_provider_connection_user_id", "provider_connection", ["user_id"])
    op.create_index(
        "ix_provider_connection_user_kind", "provider_connection", ["user_id", "provider_kind"]
    )
    credentials = op.create_table(
        "provider_credential",
        *_identity_columns(),
        sa.Column(
            "connection_id",
            sa.UUID(),
            sa.ForeignKey("provider_connection.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("secret_ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("hint", sa.String(4), nullable=False),
        sa.UniqueConstraint("connection_id", "name", name="uq_provider_credential_name"),
    )
    op.create_index("ix_provider_credential_user_id", "provider_credential", ["user_id"])
    for table in ("external_source", "llm_setting"):
        op.add_column(table, sa.Column("connection_id", sa.UUID(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_connection_id_provider_connection",
            table,
            "provider_connection",
            ["connection_id"],
            ["id"],
            ondelete="SET NULL",
        )
    bind = op.get_bind()
    sources = bind.execute(
        sa.text("SELECT * FROM external_source WHERE deleted_at IS NULL")
    ).mappings()
    for source in sources:
        connection_id = uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:source:{source['id']}")
        entries = source["adapter_spec"].get("credentials", [])
        if not isinstance(entries, list):
            entries = []
        required = [
            entry["name"]
            for entry in entries
            if isinstance(entry, dict) and isinstance(entry.get("name"), str)
        ]
        bind.execute(
            connections.insert().values(
                id=connection_id,
                user_id=source["user_id"],
                name=source["name"],
                provider_kind="dailyshot"
                if source["preset_key"] == "dailyshot" and not required
                else "source",
                is_active=source["is_active"],
                config_revision=source["config_revision"],
                rate_limit_per_min=source["rate_limit_per_min"],
                request_limit_per_day=source["request_limit_per_day"],
                required_fields=required,
                origin_kind="source",
                origin_id=source["id"],
                last_outcome="unknown",
                created_at=source["created_at"],
                updated_at=source["updated_at"],
            )
        )
        bind.execute(
            sa.text("UPDATE external_source SET connection_id=:connection WHERE id=:source"),
            {"connection": connection_id, "source": source["id"]},
        )
        rows = bind.execute(
            sa.text(
                "SELECT * FROM external_source_credential WHERE source_id=:source "
                "AND user_id=:user AND deleted_at IS NULL"
            ),
            {"source": source["id"], "user": source["user_id"]},
        ).mappings()
        for row in rows:
            bind.execute(
                credentials.insert().values(
                    id=uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:credential:{row['id']}"),
                    user_id=row["user_id"],
                    connection_id=connection_id,
                    name=row["name"],
                    secret_ciphertext=row["secret_ciphertext"],
                    hint=row["hint"],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
            )
    users_seen = set()
    settings = bind.execute(
        sa.text(
            "SELECT * FROM llm_setting WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC"
        )
    ).mappings()
    for setting in settings:
        connection_id = uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:llm:{setting['id']}")
        selected = setting["user_id"] not in users_seen
        users_seen.add(setting["user_id"])
        bind.execute(
            connections.insert().values(
                id=connection_id,
                user_id=setting["user_id"],
                provider_kind="openai_ocr",
                name="OpenAI · 라벨 인식" if selected else "OpenAI · 이전 라벨 인식 설정",
                is_active=selected,
                config_revision=1,
                rate_limit_per_min=6,
                request_limit_per_day=1000,
                required_fields=["api_key"],
                origin_kind="llm",
                origin_id=setting["id"],
                last_outcome="unknown",
                created_at=setting["created_at"],
                updated_at=setting["updated_at"],
            )
        )
        bind.execute(
            credentials.insert().values(
                id=uuid.uuid5(uuid.NAMESPACE_URL, f"sooljang:llm-credential:{setting['id']}"),
                user_id=setting["user_id"],
                connection_id=connection_id,
                name="api_key",
                secret_ciphertext=setting["api_key_ciphertext"],
                hint=setting["api_key_hint"],
                created_at=setting["created_at"],
                updated_at=setting["updated_at"],
            )
        )
        bind.execute(
            sa.text("UPDATE llm_setting SET connection_id=:connection WHERE id=:setting"),
            {"connection": connection_id, "setting": setting["id"]},
        )


def downgrade() -> None:
    for table in ("llm_setting", "external_source"):
        op.drop_constraint(
            f"fk_{table}_connection_id_provider_connection", table, type_="foreignkey"
        )
        op.drop_column(table, "connection_id")
    op.drop_table("provider_credential")
    op.drop_table("provider_connection")
