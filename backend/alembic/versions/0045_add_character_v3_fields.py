"""add V3 character card fields to characters

Revision ID: 0045_add_character_v3_fields
Revises: 0044_add_message_hidden_locked_fields
Create Date: 2026-07-15

New columns:
- characters.talkativeness (String, default="0.5", nullable=True)
  ST 1.18.0 uses string for this field; controls group chat speaker weight.
- characters.nickname (String, nullable=True)
  Character display nickname (V3 chara card field).
- characters.group_only_greetings (Text, nullable=True)
  JSON array of greetings used only in group chats (V3 chara card field).
"""
from alembic import op
import sqlalchemy as sa


revision = '0045_add_character_v3_fields'
down_revision = '0044_add_message_hidden_locked_fields'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    table_name = "characters"
    if not _column_exists(table_name, "talkativeness"):
        op.add_column(
            table_name,
            sa.Column("talkativeness", sa.String(), nullable=True, server_default="0.5"),
        )
    if not _column_exists(table_name, "nickname"):
        op.add_column(
            table_name,
            sa.Column("nickname", sa.String(), nullable=True),
        )
    if not _column_exists(table_name, "group_only_greetings"):
        op.add_column(
            table_name,
            sa.Column("group_only_greetings", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    table_name = "characters"
    for column_name in ("group_only_greetings", "nickname", "talkativeness"):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
