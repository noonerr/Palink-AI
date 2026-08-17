"""add silly tavern mode settings

Revision ID: 0030_add_silly_tavern_user_settings
Revises: 0028_merge_memory_and_plugins_heads
Create Date: 2026-06-10

"""
from alembic import op
import sqlalchemy as sa


revision = '0030_add_silly_tavern_user_settings'
down_revision = '0028_merge_memory_and_plugins_heads'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("user_settings", "silly_tavern_mode"):
        op.add_column(
            "user_settings",
            sa.Column("silly_tavern_mode", sa.String(), nullable=True, server_default="compat"),
        )
    if not _column_exists("user_settings", "silly_tavern_theme"):
        op.add_column(
            "user_settings",
            sa.Column("silly_tavern_theme", sa.String(), nullable=True, server_default="palink"),
        )


def downgrade() -> None:
    if _column_exists("user_settings", "silly_tavern_theme"):
        op.drop_column("user_settings", "silly_tavern_theme")
    if _column_exists("user_settings", "silly_tavern_mode"):
        op.drop_column("user_settings", "silly_tavern_mode")
