"""add show_character_status to user settings

Revision ID: 0017_add_show_character_status
Revises: 0016_add_custom_prompts
Create Date: 2025-05-18 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0017_add_show_character_status'
down_revision = '0016_add_custom_prompts'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("user_settings", "show_character_status"):
        op.add_column(
            "user_settings",
            sa.Column("show_character_status", sa.Boolean(), nullable=True, server_default="false"),
        )


def downgrade():
    op.drop_column("user_settings", "show_character_status")
