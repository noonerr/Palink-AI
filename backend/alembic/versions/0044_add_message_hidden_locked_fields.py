"""add is_hidden and is_locked to character_chat_messages

Revision ID: 0044_add_message_hidden_locked_fields
Revises: 0043_add_chat_metadata_and_background
Create Date: 2026-07-15

New columns:
- character_chat_messages.is_hidden (Boolean, default=False, nullable=False)
  ST 1.18.0 hidden message flag (excluded from prompt assembly)
- character_chat_messages.is_locked (Boolean, default=False, nullable=False)
  ST 1.18.0 locked message flag (prevents editing/deletion in UI)
"""
from alembic import op
import sqlalchemy as sa


revision = '0044_add_message_hidden_locked_fields'
down_revision = '0043_add_chat_metadata_and_background'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    table_name = "character_chat_messages"
    if not _column_exists(table_name, "is_hidden"):
        op.add_column(
            table_name,
            sa.Column("is_hidden", sa.Boolean(), nullable=False, server_default="0"),
        )
    if not _column_exists(table_name, "is_locked"):
        op.add_column(
            table_name,
            sa.Column("is_locked", sa.Boolean(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    table_name = "character_chat_messages"
    for column_name in ("is_locked", "is_hidden"):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
