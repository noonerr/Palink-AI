"""add extensions_json to world_book_stages table

Revision ID: 0032_add_worldbook_stage_extensions_json
Revises: 0031_add_preset_prompts_data
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa


revision = '0032_add_worldbook_stage_extensions_json'
down_revision = '0031_add_preset_prompts_data'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("world_book_stages", "extensions_json"):
        op.add_column(
            "world_book_stages",
            sa.Column("extensions_json", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("world_book_stages", "extensions_json"):
        op.drop_column("world_book_stages", "extensions_json")
