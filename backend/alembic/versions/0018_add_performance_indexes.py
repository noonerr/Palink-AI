"""add performance indexes for message ordering

Revision ID: 0018_add_performance_indexes
Revises: 0017_add_performance_indexes
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa

revision = '0018_add_performance_indexes'
down_revision = '0017_add_performance_indexes'
branch_labels = None
depends_on = None


def _index_exists(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    indexes = insp.get_indexes(table_name)
    return any(idx["name"] == index_name for idx in indexes)


def upgrade():
    if not _index_exists("messages", "ix_messages_session_created"):
        op.create_index(
            'ix_messages_session_created',
            'messages',
            ['session_id', 'created_at'],
            unique=False
        )
    if not _index_exists("character_chat_messages", "idx_ccm_session_branch_created"):
        op.create_index(
            'idx_ccm_session_branch_created',
            'character_chat_messages',
            ['session_id', 'branch_id', 'created_at'],
            unique=False
        )


def downgrade():
    if _index_exists("character_chat_messages", "idx_ccm_session_branch_created"):
        op.drop_index('idx_ccm_session_branch_created', table_name='character_chat_messages')
    if _index_exists("messages", "ix_messages_session_created"):
        op.drop_index('ix_messages_session_created', table_name='messages')
