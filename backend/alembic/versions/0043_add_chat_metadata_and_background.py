"""add chat_metadata and background to character_chat_sessions

Revision ID: 0043_add_chat_metadata_and_background
Revises: 0042_unify_author_note_position
Create Date: 2026-07-15

New columns:
- character_chat_sessions.chat_metadata (Text, default "{}")
  ST 1.18.0 chat_metadata persistence (note_prompt / variables / hidden_bots / etc.)
- character_chat_sessions.background (String, nullable=True)
  ST 1.18.0 background image filename/path for this session
"""
from alembic import op
import sqlalchemy as sa


revision = '0043_add_chat_metadata_and_background'
down_revision = '0042_unify_author_note_position'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    table_name = "character_chat_sessions"
    if not _column_exists(table_name, "chat_metadata"):
        op.add_column(
            table_name,
            sa.Column("chat_metadata", sa.Text(), nullable=False, server_default="{}"),
        )
    if not _column_exists(table_name, "background"):
        op.add_column(
            table_name,
            sa.Column("background", sa.String(), nullable=True),
        )


def downgrade() -> None:
    table_name = "character_chat_sessions"
    for column_name in ("background", "chat_metadata"):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
