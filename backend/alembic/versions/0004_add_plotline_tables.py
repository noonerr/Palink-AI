"""add plotline tables

Revision ID: 0004_add_plotline_tables
Revises: 0003_worldbook_keyword_mode
Create Date: 2026-03-11

Creates plot_lines, plot_stages, and session_plot_lines tables.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0004_add_plotline_tables'
down_revision: Union[str, None] = '0003_worldbook_keyword_mode'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_exists(table_name: str) -> bool:
    from sqlalchemy import inspect
    bind = op.get_bind()
    inspector = inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _table_exists('plot_lines'):
        op.create_table(
            'plot_lines',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
            sa.Column('name', sa.String(), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('raw_content', sa.Text(), nullable=True),
            sa.Column('is_parsed', sa.Boolean(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )

    if not _table_exists('plot_stages'):
        op.create_table(
            'plot_stages',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('plot_line_id', sa.String(), sa.ForeignKey('plot_lines.id', ondelete='CASCADE'), nullable=True),
            sa.Column('stage_index', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('title', sa.String(), nullable=True),
            sa.Column('content', sa.Text(), nullable=False),
            sa.Column('summary', sa.Text(), nullable=True),
            sa.Column('transition_hint', sa.Text(), nullable=True),
            sa.Column('priority', sa.Integer(), nullable=False, server_default='5'),
            sa.Column('token_count', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )

    if not _table_exists('session_plot_lines'):
        op.create_table(
            'session_plot_lines',
            sa.Column('id', sa.String(), nullable=False),
            sa.Column('session_id', sa.String(), sa.ForeignKey('character_chat_sessions.id', ondelete='CASCADE'), nullable=True),
            sa.Column('plot_line_id', sa.String(), sa.ForeignKey('plot_lines.id', ondelete='CASCADE'), nullable=True),
            sa.Column('current_stage_index', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('stage_transition_mode', sa.String(), nullable=False, server_default='manual'),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('session_id', name='uq_session_plotline'),
        )


def downgrade() -> None:
    # Drop in reverse order
    if _table_exists('session_plot_lines'):
        op.drop_table('session_plot_lines')
    if _table_exists('plot_stages'):
        op.drop_table('plot_stages')
    if _table_exists('plot_lines'):
        op.drop_table('plot_lines')
