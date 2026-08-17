"""add tts voice management tables

Revision ID: 0022_add_tts_voice_management
Revises: 0021_add_worldbook_type
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa


revision = '0022_add_tts_voice_management'
down_revision = '0021_add_worldbook_type'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return table_name in insp.get_table_names()


def _index_exists(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    indexes = insp.get_indexes(table_name)
    return any(idx["name"] == index_name for idx in indexes)


def upgrade() -> None:
    if not _table_exists("tts_clone_samples"):
        op.create_table(
            "tts_clone_samples",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("provider_id", sa.String(), server_default="xiaomi_mimo", nullable=False),
            sa.Column("source_voice_id", sa.String(), nullable=True),
            sa.Column("filename", sa.String(), nullable=False),
            sa.Column("file_path", sa.String(), nullable=False),
            sa.Column("file_size", sa.Integer(), server_default="0", nullable=False),
            sa.Column("mime_type", sa.String(), nullable=True),
            sa.Column("duration_seconds", sa.Float(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    if not _index_exists("tts_clone_samples", "ix_tts_clone_samples_user_id"):
        op.create_index("ix_tts_clone_samples_user_id", "tts_clone_samples", ["user_id"], unique=False)

    if not _table_exists("tts_voice_bindings"):
        op.create_table(
            "tts_voice_bindings",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("scope", sa.String(), nullable=False),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("character_id", sa.String(), sa.ForeignKey("characters.id"), nullable=True),
            sa.Column("role", sa.String(), server_default="character", nullable=False),
            sa.Column("provider_id", sa.String(), nullable=True),
            sa.Column("voice_id", sa.String(), nullable=True),
            sa.Column("gender", sa.String(), nullable=True),
            sa.Column("clone_sample_id", sa.String(), sa.ForeignKey("tts_clone_samples.id"), nullable=True),
            sa.Column("speed", sa.Float(), server_default="1.0", nullable=True),
            sa.Column("volume", sa.Float(), server_default="1.0", nullable=True),
            sa.Column("enabled", sa.Boolean(), server_default=sa.text("1"), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    for index_name, columns in {
        "ix_tts_voice_bindings_scope": ["scope"],
        "ix_tts_voice_bindings_user_id": ["user_id"],
        "ix_tts_voice_bindings_character_id": ["character_id"],
        "ix_tts_voice_bindings_role": ["role"],
        "idx_tts_binding_user_character_role": ["user_id", "character_id", "role"],
    }.items():
        if not _index_exists("tts_voice_bindings", index_name):
            op.create_index(index_name, "tts_voice_bindings", columns, unique=False)


def downgrade() -> None:
    for index_name in [
        "idx_tts_binding_user_character_role",
        "ix_tts_voice_bindings_role",
        "ix_tts_voice_bindings_character_id",
        "ix_tts_voice_bindings_user_id",
        "ix_tts_voice_bindings_scope",
    ]:
        if _table_exists("tts_voice_bindings") and _index_exists("tts_voice_bindings", index_name):
            op.drop_index(index_name, table_name="tts_voice_bindings")
    if _table_exists("tts_voice_bindings"):
        op.drop_table("tts_voice_bindings")

    if _table_exists("tts_clone_samples") and _index_exists("tts_clone_samples", "ix_tts_clone_samples_user_id"):
        op.drop_index("ix_tts_clone_samples_user_id", table_name="tts_clone_samples")
    if _table_exists("tts_clone_samples"):
        op.drop_table("tts_clone_samples")
