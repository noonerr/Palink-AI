"""add branch indexes for performance

Revision ID: 0013_add_branch_indexes
Revises: 0012_add_reasoning_tokens
Create Date: 2026-05-10

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '0013_add_branch_indexes'
down_revision = '0012_add_reasoning_tokens'
branch_labels = None
depends_on = None


def upgrade():
    # Add composite indexes for CharacterChatSessionBranch
    op.create_index(
        'idx_branch_parent_lookup',
        'character_chat_session_branches',
        ['session_id', 'parent_branch_id', 'parent_message_id'],
        unique=False
    )
    op.create_index(
        'idx_branch_session_active',
        'character_chat_session_branches',
        ['session_id', 'is_active'],
        unique=False
    )

    # Add composite indexes for CharacterChatMessage
    op.create_index(
        'idx_message_branch_lookup',
        'character_chat_messages',
      ['session_id', 'branch_id', 'created_at'],
        unique=False
    )
    op.create_index(
        'idx_message_role_lookup',
        'character_chat_messages',
        ['session_id', 'branch_id', 'role', 'id'],
        unique=False
    )


def downgrade():
    # Remove indexes in reverse order
    op.drop_index('idx_message_role_lookup', table_name='character_chat_messages')
    op.drop_index('idx_message_branch_lookup', table_name='character_chat_messages')
    op.drop_index('idx_branch_session_active', table_name='character_chat_session_branches')
    op.drop_index('idx_branch_parent_lookup', table_name='character_chat_session_branches')
