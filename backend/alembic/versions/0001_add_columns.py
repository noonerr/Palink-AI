"""add missing columns to existing tables

Revision ID: 0001_add_columns
Revises:
Create Date: 2025-01-01

This migration replaces the raw ALTER TABLE operations that were previously
in app/core/migrations.py. It adds columns that were introduced after the
initial table creation.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0001_add_columns'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _add_column_if_not_exists(table: str, column_name: str, column_type: sa.types.TypeEngine, **kwargs) -> None:
    """Helper to add a column only if it doesn't already exist (idempotent)."""
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    columns = [c['name'] for c in inspector.get_columns(table)]
    if column_name not in columns:
        with op.batch_alter_table(table) as batch_op:
            batch_op.add_column(sa.Column(column_name, column_type, **kwargs))


def upgrade() -> None:
    # sessions.type — 会话类型 (chat/workspace)
    _add_column_if_not_exists('sessions', 'type', sa.Text(), server_default='chat')

    # user_files.summary — 文件摘要
    _add_column_if_not_exists('user_files', 'summary', sa.Text(), nullable=True)

    # characters 表新增字段
    _add_column_if_not_exists('characters', 'scenario', sa.Text(), nullable=True)
    _add_column_if_not_exists('characters', 'first_mes', sa.Text(), nullable=True)
    _add_column_if_not_exists('characters', 'mes_example', sa.Text(), nullable=True)
    _add_column_if_not_exists('characters', 'system_prompt', sa.Text(), nullable=True)

    # characters 表额外字段 (原 migrate_database.py)
    _add_column_if_not_exists('characters', 'user_nickname', sa.Text(), nullable=True)
    _add_column_if_not_exists('characters', 'is_processing', sa.Boolean(), server_default='0')


def downgrade() -> None:
    # 使用 batch mode 以兼容 SQLite
    with op.batch_alter_table('characters') as batch_op:
        batch_op.drop_column('is_processing')
        batch_op.drop_column('user_nickname')
        batch_op.drop_column('system_prompt')
        batch_op.drop_column('mes_example')
        batch_op.drop_column('first_mes')
        batch_op.drop_column('scenario')

    with op.batch_alter_table('user_files') as batch_op:
        batch_op.drop_column('summary')

    with op.batch_alter_table('sessions') as batch_op:
        batch_op.drop_column('type')
