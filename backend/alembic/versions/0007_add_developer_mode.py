"""add developer_mode to user_settings

Revision ID: 0007_add_developer_mode
Revises: 0006_add_prompt_language
Create Date: 2026-03-31 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0007_add_developer_mode'
down_revision = '0006_add_prompt_language'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("user_settings", "developer_mode"):
        op.add_column(
            "user_settings",
            sa.Column("developer_mode", sa.Boolean(), nullable=True, server_default=sa.false()),
        )


def downgrade():
    op.drop_column("user_settings", "developer_mode")
