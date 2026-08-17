"""add prompts_data to generation_presets table

Revision ID: 0031_add_preset_prompts_data
Revises: 0030_add_silly_tavern_user_settings
Create Date: 2026-06-10
"""
from alembic import op
import sqlalchemy as sa


revision = '0031_add_preset_prompts_data'
down_revision = '0030_add_silly_tavern_user_settings'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("generation_presets", "prompts_data"):
        op.add_column(
            "generation_presets",
            sa.Column("prompts_data", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("generation_presets", "prompts_data"):
        op.drop_column("generation_presets", "prompts_data")
