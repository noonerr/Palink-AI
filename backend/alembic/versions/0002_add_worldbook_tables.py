"""add world book tables

Revision ID: 0002_add_worldbook_tables
Revises: add_memory_tables
Create Date: 2026-03-11

Adds world_books, world_book_stages, and session_world_books tables.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0002_add_worldbook_tables'
down_revision: Union[str, None] = 'add_memory_tables'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(table_name: str) -> bool:
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _table_exists('world_books'):
        op.create_table(
            'world_books',
            sa.Column('id', sa.String(), primary_key=True),
            sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
            sa.Column('name', sa.String(), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('source_type', sa.String(), server_default='online_edit'),
            sa.Column('raw_content', sa.Text(), nullable=True),
            sa.Column('format', sa.String(), server_default='custom'),
            sa.Column('tags', sa.Text(), nullable=True),
            sa.Column('is_parsed', sa.Boolean(), server_default='0'),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
        )

    if not _table_exists('world_book_stages'):
        op.create_table(
            'world_book_stages',
            sa.Column('id', sa.String(), primary_key=True),
            sa.Column('world_book_id', sa.String(),
                       sa.ForeignKey('world_books.id', ondelete='CASCADE'), nullable=False),
            sa.Column('stage_index', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('title', sa.String(), nullable=True),
            sa.Column('content', sa.Text(), nullable=False),
            sa.Column('summary', sa.Text(), nullable=True),
            sa.Column('transition_hint', sa.Text(), nullable=True),
            sa.Column('priority', sa.Integer(), server_default='5'),
            sa.Column('token_count', sa.Integer(), server_default='0'),
            sa.Column('image_prompt', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
        )

    if not _table_exists('session_world_books'):
        op.create_table(
            'session_world_books',
            sa.Column('id', sa.String(), primary_key=True),
            sa.Column('session_id', sa.String(),
                       sa.ForeignKey('character_chat_sessions.id', ondelete='CASCADE'), nullable=False),
            sa.Column('world_book_id', sa.String(),
                       sa.ForeignKey('world_books.id', ondelete='CASCADE'), nullable=False),
            sa.Column('current_stage_index', sa.Integer(), server_default='0'),
            sa.Column('stage_transition_mode', sa.String(), server_default='auto'),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.UniqueConstraint('session_id', name='uq_session_worldbook'),
        )


def downgrade() -> None:
    op.drop_table('session_world_books')
    op.drop_table('world_book_stages')
    op.drop_table('world_books')
