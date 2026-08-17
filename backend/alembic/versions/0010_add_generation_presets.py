"""add generation_presets table

Revision ID: 0010_add_generation_presets
Revises: 0009_add_character_display_mode
Create Date: 2026-04-30 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = '0010_add_generation_presets'
down_revision = '0009_add_character_display_mode'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return table_name in insp.get_table_names()


def upgrade():
    if not _table_exists("generation_presets"):
        op.create_table(
            "generation_presets",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
            sa.Column("activation_regex", sa.String(), nullable=True),
            sa.Column("temperature", sa.Float(), server_default="0.7", nullable=False),
            sa.Column("top_p", sa.Float(), server_default="0.95", nullable=False),
            sa.Column("max_tokens", sa.Integer(), server_default="1024", nullable=False),
            sa.Column("frequency_penalty", sa.Float(), server_default="0.0", nullable=False),
            sa.Column("presence_penalty", sa.Float(), server_default="0.0", nullable=False),
            sa.Column("min_p", sa.Float(), server_default="0.05", nullable=False),
            sa.Column("top_k", sa.Integer(), server_default="40", nullable=False),
            sa.Column("repetition_penalty", sa.Float(), server_default="1.1", nullable=False),
            sa.Column("system_prompt_override", sa.Text(), nullable=True),
            sa.Column("post_history_instructions", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )


def downgrade():
    if _table_exists("generation_presets"):
        op.drop_table("generation_presets")
