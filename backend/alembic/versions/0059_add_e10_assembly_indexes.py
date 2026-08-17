"""add_e10_assembly_indexes

Revision ID: 0059_add_e10_assembly_indexes
Revises: 0058_add_extension_prompt_scan
Create Date: 2026-08-11
"""
from alembic import op
import sqlalchemy as sa

revision = '0059_add_e10_assembly_indexes'
down_revision = '0058_add_extension_prompt_scan'
branch_labels = None
depends_on = None


def upgrade():
    # E-10 修复: prompt 装配高频查询补索引。
    # CONCURRENTLY 不阻塞读写（PostgreSQL）；SQLite 方言下忽略该参数。
    with op.get_context().autocommit_block():
        op.create_index(
            'ix_extension_prompts_user_session',
            'extension_prompts',
            ['user_id', 'session_id'],
            postgresql_concurrently=True,
        )
        op.create_index(
            'ix_world_books_user_character',
            'world_books',
            ['user_id', 'character_id'],
            postgresql_concurrently=True,
        )
        op.create_index(
            'ix_world_book_stages_world_book',
            'world_book_stages',
            ['world_book_id'],
            postgresql_concurrently=True,
        )


def downgrade():
    with op.get_context().autocommit_block():
        op.drop_index(
            'ix_world_book_stages_world_book',
            table_name='world_book_stages',
            postgresql_concurrently=True,
        )
        op.drop_index(
            'ix_world_books_user_character',
            table_name='world_books',
            postgresql_concurrently=True,
        )
        op.drop_index(
            'ix_extension_prompts_user_session',
            table_name='extension_prompts',
            postgresql_concurrently=True,
        )
