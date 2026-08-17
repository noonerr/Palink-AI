"""add group_chats top-level ST 1.18.0 fields (generation_mode_join_prefix/suffix, auto_mode_delay)

Revision ID: 0055_add_group_chat_st1180_fields
Revises: 0054_add_jailbreak_fields
Create Date: 2026-07-24

New columns (ST 1.18.0 group chat parity, Phase D F6):
- group_chats.generation_mode_join_prefix (Text, nullable)
  ST group-chats.js:497-571 customTransform/replaceAndPrepareForJoin prefix.
  Previously stored only in chat_metadata.meta; promoted to top-level for
  direct API read/write. Assembly reads top-level first, falls back to meta.
- group_chats.generation_mode_join_suffix (Text, nullable)
  Same as above, suffix side.
- group_chats.auto_mode_delay (Integer, nullable)
  ST group auto mode delay (ms) between speaker generations.

Backward compatibility: existing chat_metadata.meta values remain readable;
the assembly layer prefers top-level columns, falling back to meta when NULL.
"""
from alembic import op
import sqlalchemy as sa


revision = '0055_add_group_chat_st1180_fields'
down_revision = '0054_add_jailbreak_fields'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = [c['name'] for c in inspector.get_columns(table_name)]
    return column_name in columns


def upgrade() -> None:
    if not _column_exists('group_chats', 'generation_mode_join_prefix'):
        op.add_column('group_chats',
                      sa.Column('generation_mode_join_prefix', sa.Text(), nullable=True))
    if not _column_exists('group_chats', 'generation_mode_join_suffix'):
        op.add_column('group_chats',
                      sa.Column('generation_mode_join_suffix', sa.Text(), nullable=True))
    if not _column_exists('group_chats', 'auto_mode_delay'):
        op.add_column('group_chats',
                      sa.Column('auto_mode_delay', sa.Integer(), nullable=True))


def downgrade() -> None:
    if _column_exists('group_chats', 'auto_mode_delay'):
        op.drop_column('group_chats', 'auto_mode_delay')
    if _column_exists('group_chats', 'generation_mode_join_suffix'):
        op.drop_column('group_chats', 'generation_mode_join_suffix')
    if _column_exists('group_chats', 'generation_mode_join_prefix'):
        op.drop_column('group_chats', 'generation_mode_join_prefix')
