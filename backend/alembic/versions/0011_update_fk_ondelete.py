"""update foreign key ondelete constraints

Revision ID: 0011_update_fk_ondelete
Revises: 0010_add_generation_presets
Create Date: 2026-05-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0011_update_fk_ondelete'
down_revision = '0010_add_generation_presets'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return table_name in insp.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect != 'postgresql':
        return

    if not _table_exists('character_chat_session_branches'):
        return
    if not _table_exists('character_chat_messages'):
        return

    op.execute("""
        ALTER TABLE character_chat_session_branches
        DROP CONSTRAINT IF EXISTS character_chat_session_branches_session_id_fkey,
        ADD CONSTRAINT character_chat_session_branches_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES character_chat_sessions(id) ON DELETE CASCADE;
    """)

    op.execute("""
        ALTER TABLE character_chat_session_branches
        DROP CONSTRAINT IF EXISTS character_chat_session_branches_parent_branch_id_fkey,
        ADD CONSTRAINT character_chat_session_branches_parent_branch_id_fkey
            FOREIGN KEY (parent_branch_id) REFERENCES character_chat_session_branches(id) ON DELETE SET NULL;
    """)

    op.execute("""
        ALTER TABLE character_chat_messages
        DROP CONSTRAINT IF EXISTS character_chat_messages_session_id_fkey,
        ADD CONSTRAINT character_chat_messages_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES character_chat_sessions(id) ON DELETE CASCADE;
    """)

    op.execute("""
        ALTER TABLE character_chat_messages
        DROP CONSTRAINT IF EXISTS character_chat_messages_branch_id_fkey,
        ADD CONSTRAINT character_chat_messages_branch_id_fkey
            FOREIGN KEY (branch_id) REFERENCES character_chat_session_branches(id) ON DELETE SET NULL;
    """)


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect != 'postgresql':
        return

    if not _table_exists('character_chat_session_branches'):
        return
    if not _table_exists('character_chat_messages'):
        return

    op.execute("""
        ALTER TABLE character_chat_session_branches
        DROP CONSTRAINT IF EXISTS character_chat_session_branches_session_id_fkey,
        ADD CONSTRAINT character_chat_session_branches_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES character_chat_sessions(id);
    """)

    op.execute("""
        ALTER TABLE character_chat_session_branches
        DROP CONSTRAINT IF EXISTS character_chat_session_branches_parent_branch_id_fkey,
        ADD CONSTRAINT character_chat_session_branches_parent_branch_id_fkey
            FOREIGN KEY (parent_branch_id) REFERENCES character_chat_session_branches(id);
    """)

    op.execute("""
        ALTER TABLE character_chat_messages
        DROP CONSTRAINT IF EXISTS character_chat_messages_session_id_fkey,
        ADD CONSTRAINT character_chat_messages_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES character_chat_sessions(id);
    """)

    op.execute("""
        ALTER TABLE character_chat_messages
        DROP CONSTRAINT IF EXISTS character_chat_messages_branch_id_fkey,
        ADD CONSTRAINT character_chat_messages_branch_id_fkey
            FOREIGN KEY (branch_id) REFERENCES character_chat_session_branches(id);
    """)
