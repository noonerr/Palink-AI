"""add branch frozen and favorite fields

Revision ID: 0008_add_branch_frozen_favorite
Revises: 0007_add_developer_mode
Create Date: 2026-05-10 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime, timezone


revision = '0008_add_branch_frozen_favorite'
down_revision = '0007_add_developer_mode'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    # 添加 is_frozen 字段
    if not _column_exists("character_chat_session_branches", "is_frozen"):
        op.add_column(
            "character_chat_session_branches",
            sa.Column("is_frozen", sa.Boolean(), nullable=True, server_default=sa.false()),
        )

    # 添加 is_favorited 字段
    if not _column_exists("character_chat_session_branches", "is_favorited"):
        op.add_column(
            "character_chat_session_branches",
            sa.Column("is_favorited", sa.Boolean(), nullable=True, server_default=sa.false()),
        )

    # 添加 last_message_at 字段
    if not _column_exists("character_chat_session_branches", "last_message_at"):
        op.add_column(
            "character_chat_session_branches",
            sa.Column("last_message_at", sa.DateTime(), nullable=True),
        )
        # 为现有记录设置默认值为 created_at
        op.execute(
            "UPDATE character_chat_session_branches SET last_message_at = created_at WHERE last_message_at IS NULL"
        )


def downgrade():
    op.drop_column("character_chat_session_branches", "last_message_at")
    op.drop_column("character_chat_session_branches", "is_favorited")
    op.drop_column("character_chat_session_branches", "is_frozen")
