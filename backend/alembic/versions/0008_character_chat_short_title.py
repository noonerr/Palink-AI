"""add short_title to character_chat_messages

Revision ID: 0008_character_chat_short_title
Revises: 0007_add_developer_mode
Create Date: 2026-04-06 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "0008_character_chat_short_title"
down_revision = "0007_add_developer_mode"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("character_chat_messages", "short_title"):
        op.add_column(
            "character_chat_messages",
            sa.Column("short_title", sa.String(), nullable=True),
        )


def downgrade():
    op.drop_column("character_chat_messages", "short_title")
