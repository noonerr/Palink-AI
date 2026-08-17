"""add ui_settings to user_settings

Revision ID: 0048_add_user_setting_ui_settings
Revises: 0047_add_prompt_preset_order_fields
Create Date: 2026-07-15

New column:
- user_settings.ui_settings (Text, nullable=True)
  JSON for UI-specific settings (separate from power_user). Defaults to
  empty JSON "{}" when unset. ST 1.18.0 stores additional UI preferences
  here (panel collapsed states, sidebar width, etc.).
"""
from alembic import op
import sqlalchemy as sa


revision = '0048_add_user_setting_ui_settings'
down_revision = '0047_add_prompt_preset_order_fields'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    table_name = "user_settings"
    if not _column_exists(table_name, "ui_settings"):
        op.add_column(
            table_name,
            sa.Column("ui_settings", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    table_name = "user_settings"
    if _column_exists(table_name, "ui_settings"):
        op.drop_column(table_name, "ui_settings")
