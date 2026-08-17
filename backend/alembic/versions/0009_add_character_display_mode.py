"""add character_display_mode to user_settings

Revision ID: 0009_add_character_display_mode
Revises: 0008_character_chat_short_title
Create Date: 2026-04-28 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0009_add_character_display_mode'
down_revision = '0008_character_chat_short_title'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("user_settings", "character_display_mode"):
        op.add_column(
            "user_settings",
            sa.Column("character_display_mode", sa.String(), nullable=True, server_default="framed"),
        )


def downgrade():
    op.drop_column("user_settings", "character_display_mode")
