"""add prompt_tokens to message tables

Revision ID: 0005_add_prompt_tokens
Revises: 0004_add_plotline_tables
Create Date: 2025-01-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0005_add_prompt_tokens'
down_revision = '0004_add_plotline_tables'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("character_chat_messages", "prompt_tokens"):
        op.add_column(
            "character_chat_messages",
            sa.Column("prompt_tokens", sa.Integer(), nullable=True, server_default="0"),
        )
    if not _column_exists("messages", "prompt_tokens"):
        op.add_column(
            "messages",
            sa.Column("prompt_tokens", sa.Integer(), nullable=True, server_default="0"),
        )


def downgrade():
    op.drop_column("character_chat_messages", "prompt_tokens")
    op.drop_column("messages", "prompt_tokens")
