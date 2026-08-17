"""add_performance_indexes

Revision ID: 0017_add_performance_indexes
Revises: 0016_add_custom_prompts
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa

revision = '0017_add_performance_indexes'
down_revision = '0017_add_show_character_status'
branch_labels = None
depends_on = None

def upgrade():
    op.create_index('ix_messages_session_id', 'messages', ['session_id'])
    op.create_index('ix_sessions_user_id', 'sessions', ['user_id'])
    op.create_index('ix_characters_user_id', 'characters', ['user_id'])
    op.create_index('idx_ccs_character_user', 'character_chat_sessions', ['character_id', 'user_id'])
    op.create_index('idx_ccs_user_id', 'character_chat_sessions', ['user_id'])
    op.create_index('idx_message_branch_only', 'character_chat_messages', ['branch_id'])
    op.create_index('ix_user_files_folder_id', 'user_files', ['folder_id'])

def downgrade():
    op.drop_index('ix_user_files_folder_id', table_name='user_files')
    op.drop_index('idx_message_branch_only', table_name='character_chat_messages')
    op.drop_index('idx_ccs_user_id', table_name='character_chat_sessions')
    op.drop_index('idx_ccs_character_user', table_name='character_chat_sessions')
    op.drop_index('ix_characters_user_id', table_name='characters')
    op.drop_index('ix_sessions_user_id', table_name='sessions')
    op.drop_index('ix_messages_session_id', table_name='messages')
