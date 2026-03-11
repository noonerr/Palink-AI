"""worldbook keyword mode

Revision ID: 0003_worldbook_keyword_mode
Revises: 0002_add_worldbook_tables
Create Date: 2026-03-11

Adds keyword-trigger fields to world_book_stages and makes
current_stage_index/stage_transition_mode nullable in session_world_books.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0003_worldbook_keyword_mode'
down_revision: Union[str, None] = '0002_add_worldbook_tables'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table_name: str, column_name: str) -> bool:
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    columns = [c['name'] for c in inspector.get_columns(table_name)]
    return column_name in columns


def _table_exists(table_name: str) -> bool:
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    # Add keyword-trigger fields to world_book_stages
    if _table_exists('world_book_stages'):
        if not _column_exists('world_book_stages', 'keys'):
            op.add_column('world_book_stages', sa.Column('keys', sa.Text(), nullable=True))
        if not _column_exists('world_book_stages', 'secondary_keys'):
            op.add_column('world_book_stages', sa.Column('secondary_keys', sa.Text(), nullable=True))
        if not _column_exists('world_book_stages', 'scan_depth'):
            op.add_column('world_book_stages', sa.Column('scan_depth', sa.Integer(), nullable=False, server_default='4'))
        if not _column_exists('world_book_stages', 'position'):
            op.add_column('world_book_stages', sa.Column('position', sa.Integer(), nullable=False, server_default='4'))
        if not _column_exists('world_book_stages', 'selective'):
            op.add_column('world_book_stages', sa.Column('selective', sa.Integer(), nullable=False, server_default='0'))
        if not _column_exists('world_book_stages', 'probability'):
            op.add_column('world_book_stages', sa.Column('probability', sa.Integer(), nullable=False, server_default='100'))
        if not _column_exists('world_book_stages', 'constant'):
            op.add_column('world_book_stages', sa.Column('constant', sa.Integer(), nullable=False, server_default='0'))

    # SQLite doesn't support ALTER COLUMN to nullable, but new records will use NULL fine.
    # The columns already default to 0/auto so no action needed for session_world_books.


def downgrade() -> None:
    # SQLite does not support DROP COLUMN in older versions; skip downgrade.
    pass
