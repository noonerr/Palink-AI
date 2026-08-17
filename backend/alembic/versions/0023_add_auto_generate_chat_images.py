"""add auto generate chat images setting

Revision ID: 0023_add_auto_generate_chat_images
Revises: 0022_add_tts_voice_management
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa


revision = '0023_add_auto_generate_chat_images'
down_revision = '0022_add_tts_voice_management'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade() -> None:
    if not _column_exists("user_settings", "auto_generate_chat_images"):
        op.add_column(
            "user_settings",
            sa.Column("auto_generate_chat_images", sa.Boolean(), nullable=True, server_default="false"),
        )


def downgrade() -> None:
    if _column_exists("user_settings", "auto_generate_chat_images"):
        op.drop_column("user_settings", "auto_generate_chat_images")
