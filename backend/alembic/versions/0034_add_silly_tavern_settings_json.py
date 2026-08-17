"""add silly tavern settings json

Revision ID: 0034_add_silly_tavern_settings_json
Revises: 0033_add_character_raw_card_spec_version
Create Date: 2026-06-12
"""
from alembic import op
import sqlalchemy as sa


revision = '0034_add_silly_tavern_settings_json'
down_revision = '0033_add_character_raw_card_spec_version'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("user_settings", "silly_tavern_settings"):
        op.add_column(
            "user_settings",
            sa.Column("silly_tavern_settings", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("user_settings", "silly_tavern_settings"):
        op.drop_column("user_settings", "silly_tavern_settings")
