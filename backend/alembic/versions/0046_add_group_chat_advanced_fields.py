"""add advanced group chat member fields to group_chats

Revision ID: 0046_add_group_chat_advanced_fields
Revises: 0045_add_character_v3_fields
Create Date: 2026-07-15

New columns:
- group_chats.active_members (Text, nullable=True)
  JSON array of currently active member character IDs.
- group_chats.follower_members (Text, nullable=True)
  JSON array of follower member character IDs.
"""
from alembic import op
import sqlalchemy as sa


revision = '0046_add_group_chat_advanced_fields'
down_revision = '0045_add_character_v3_fields'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    table_name = "group_chats"
    if not _column_exists(table_name, "active_members"):
        op.add_column(
            table_name,
            sa.Column("active_members", sa.Text(), nullable=True),
        )
    if not _column_exists(table_name, "follower_members"):
        op.add_column(
            table_name,
            sa.Column("follower_members", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    table_name = "group_chats"
    for column_name in ("follower_members", "active_members"):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
