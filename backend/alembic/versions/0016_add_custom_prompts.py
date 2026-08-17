"""add custom prompts to user settings

Revision ID: 0016_add_custom_prompts
Revises: 0015_add_web_search_results
Create Date: 2025-05-12 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0016_add_custom_prompts'
down_revision = '0015_add_web_search_results'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    # Add custom prompt fields to user_settings
    if not _column_exists("user_settings", "custom_chat_prompt_zh"):
        op.add_column(
            "user_settings",
            sa.Column("custom_chat_prompt_zh", sa.Text(), nullable=True),
        )

    if not _column_exists("user_settings", "custom_chat_prompt_en"):
        op.add_column(
            "user_settings",
            sa.Column("custom_chat_prompt_en", sa.Text(), nullable=True),
    )

    if not _column_exists("user_settings", "custom_character_prompt_zh"):
        op.add_column(
            "user_settings",
          sa.Column("custom_character_prompt_zh", sa.Text(), nullable=True),
        )

    if not _column_exists("user_settings", "custom_character_prompt_en"):
        op.add_column(
         "user_settings",
       sa.Column("custom_character_prompt_en", sa.Text(), nullable=True),
        )

    if not _column_exists("user_settings", "use_custom_prompts"):
        op.add_column(
       "user_settings",
            sa.Column("use_custom_prompts", sa.Boolean(), nullable=True, server_default="false"),
        )


def downgrade():
    op.drop_column("user_settings", "use_custom_prompts")
    op.drop_column("user_settings", "custom_character_prompt_en")
    op.drop_column("user_settings", "custom_character_prompt_zh")
    op.drop_column("user_settings", "custom_chat_prompt_en")
    op.drop_column("user_settings", "custom_chat_prompt_zh")
