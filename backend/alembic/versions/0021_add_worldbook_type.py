"""add type column to world_books

Revision ID: 0021_add_worldbook_type
Revises: 0020_add_preset_data
Create Date: 2026-05-25
"""
from alembic import op
import sqlalchemy as sa


revision = '0021_add_worldbook_type'
down_revision = '0020_add_preset_data'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade() -> None:
    if not _column_exists("world_books", "type"):
        op.add_column(
            "world_books",
            sa.Column("type", sa.String(), nullable=True, server_default="world_book"),
        )
    bind = op.get_bind()
    bind.execute(
        sa.text("UPDATE world_books SET type = 'character_book' WHERE character_id IS NOT NULL AND type IS NULL")
    )
    bind.execute(
        sa.text("UPDATE world_books SET type = 'world_book' WHERE character_id IS NULL AND type IS NULL")
    )


def downgrade() -> None:
    if _column_exists("world_books", "type"):
        op.drop_column("world_books", "type")
