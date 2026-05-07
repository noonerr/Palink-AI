"""add reasoning_tokens to message tables

Revision ID: 0012_add_reasoning_tokens
Revises: 0011_update_fk_ondelete
Create Date: 2026-05-05 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0012_add_reasoning_tokens'
down_revision = '0011_update_fk_ondelete'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("character_chat_messages", "reasoning_tokens"):
        op.add_column(
            "character_chat_messages",
            sa.Column("reasoning_tokens", sa.Integer(), nullable=True, server_default="0"),
        )
    if not _column_exists("messages", "reasoning_tokens"):
        op.add_column(
            "messages",
            sa.Column("reasoning_tokens", sa.Integer(), nullable=True, server_default="0"),
        )


def downgrade():
    op.drop_column("character_chat_messages", "reasoning_tokens")
    op.drop_column("messages", "reasoning_tokens")
