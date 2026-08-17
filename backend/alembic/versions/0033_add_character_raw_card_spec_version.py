"""add raw_card_spec_version to characters table

Revision ID: 0033_add_character_raw_card_spec_version
Revises: 0032_add_worldbook_stage_extensions_json
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa


revision = '0033_add_character_raw_card_spec_version'
down_revision = '0032_add_worldbook_stage_extensions_json'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("characters", "raw_card_spec_version"):
        op.add_column(
            "characters",
            sa.Column("raw_card_spec_version", sa.String(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("characters", "raw_card_spec_version"):
        op.drop_column("characters", "raw_card_spec_version")
