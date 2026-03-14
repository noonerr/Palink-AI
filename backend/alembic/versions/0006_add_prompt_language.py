"""add prompt_language to user_settings

Revision ID: 0006_add_prompt_language
Revises: 0005_add_prompt_tokens
Create Date: 2025-03-13 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0006_add_prompt_language'
down_revision = '0005_add_prompt_tokens'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("user_settings", "prompt_language"):
        op.add_column(
            "user_settings",
            sa.Column("prompt_language", sa.String(), nullable=True, server_default="auto"),
        )


def downgrade():
    op.drop_column("user_settings", "prompt_language")
