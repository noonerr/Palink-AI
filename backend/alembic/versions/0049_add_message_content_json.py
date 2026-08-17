"""add content_json to character_chat_messages for V3 multimodal content

Revision ID: 0049_add_message_content_json
Revises: 0048_add_user_setting_ui_settings
Create Date: 2026-07-15

New column:
- character_chat_messages.content_json (Text, nullable=True)
  Stores SillyTavern V3 multimodal message content as a JSON string.
  When present, contains an array of content parts (text / image_url /
  input_audio etc.) following the OpenAI multimodal content schema.
  NULL falls back to the legacy single-string ``content`` column.
"""
from alembic import op
import sqlalchemy as sa


revision = '0049_add_message_content_json'
down_revision = '0048_add_user_setting_ui_settings'
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
    if not _column_exists(table_name, "content_json"):
        op.add_column(
            table_name,
            sa.Column("content_json", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    table_name = "character_chat_messages"
    if _column_exists(table_name, "content_json"):
        op.drop_column(table_name, "content_json")
