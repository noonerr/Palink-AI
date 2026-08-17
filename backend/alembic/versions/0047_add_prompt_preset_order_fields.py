"""add prompt_order / prompt_active / prompt_disabled / chat_completion_source to prompt_presets

Revision ID: 0047_add_prompt_preset_order_fields
Revises: 0046_add_group_chat_advanced_fields
Create Date: 2026-07-15

New columns:
- prompt_presets.prompt_order (Text, nullable=True)
  JSON array defining the order of prompt components.
- prompt_presets.prompt_active (Text, nullable=True)
  JSON array of active prompt identifiers.
- prompt_presets.prompt_disabled (Text, nullable=True)
  JSON array of disabled prompt identifiers.
- prompt_presets.chat_completion_source (String, nullable=True)
  Which chat completion source to use for this preset.
"""
from alembic import op
import sqlalchemy as sa


revision = '0047_add_prompt_preset_order_fields'
down_revision = '0046_add_group_chat_advanced_fields'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    table_name = "prompt_presets"
    if not _column_exists(table_name, "prompt_order"):
        op.add_column(
            table_name,
            sa.Column("prompt_order", sa.Text(), nullable=True),
        )
    if not _column_exists(table_name, "prompt_active"):
        op.add_column(
            table_name,
            sa.Column("prompt_active", sa.Text(), nullable=True),
        )
    if not _column_exists(table_name, "prompt_disabled"):
        op.add_column(
            table_name,
            sa.Column("prompt_disabled", sa.Text(), nullable=True),
        )
    if not _column_exists(table_name, "chat_completion_source"):
        op.add_column(
            table_name,
            sa.Column("chat_completion_source", sa.String(), nullable=True),
        )


def downgrade() -> None:
    table_name = "prompt_presets"
    for column_name in ("chat_completion_source", "prompt_disabled", "prompt_active", "prompt_order"):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
