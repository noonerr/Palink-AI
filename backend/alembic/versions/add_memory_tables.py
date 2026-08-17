"""add memory tables

Revision ID: add_memory_tables
Revises: 
Create Date: 2026-02-08

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_memory_tables'
down_revision = '0001_add_columns'
branch_labels = None
depends_on = None


def upgrade():
    # 创建 pgvector 扩展
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    
    # 创建对话记忆表
    op.create_table(
        'conversation_memories',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.String(), nullable=False),
        sa.Column('role', sa.String(), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('content_summary', sa.Text(), nullable=True),
        sa.Column('embedding', postgresql.ARRAY(sa.FLOAT()), nullable=True),
        sa.Column('importance_score', sa.Float(), nullable=True, server_default='0.5'),
        sa.Column('topics', postgresql.JSON(), nullable=True, server_default='[]'),
        sa.Column('tokens_count', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=True, server_default=sa.text('NOW()')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    
    # 创建索引
    op.create_index('idx_memory_user_id', 'conversation_memories', ['user_id'])
    op.create_index('idx_memory_session_id', 'conversation_memories', ['session_id'])
    op.create_index('idx_memory_created_at', 'conversation_memories', ['created_at'])
    
    # 创建用户画像表
    op.create_table(
        'user_profiles',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('preferences', postgresql.JSON(), nullable=True, server_default='{}'),
        sa.Column('goals', postgresql.JSON(), nullable=True, server_default='[]'),
        sa.Column('common_topics', postgresql.JSON(), nullable=True, server_default='[]'),
        sa.Column('communication_style', sa.String(), nullable=True),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('total_conversations', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('total_messages', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('updated_at', sa.DateTime(), nullable=True, server_default=sa.text('NOW()')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id')
    )
    
    op.create_index('idx_profile_user_id', 'user_profiles', ['user_id'])


def downgrade():
    op.drop_index('idx_profile_user_id', table_name='user_profiles')
    op.drop_table('user_profiles')
    
    op.drop_index('idx_memory_created_at', table_name='conversation_memories')
    op.drop_index('idx_memory_session_id', table_name='conversation_memories')
    op.drop_index('idx_memory_user_id', table_name='conversation_memories')
    op.drop_table('conversation_memories')
