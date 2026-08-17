"""add prompt_presets, personas, extension_prompts tables

Revision ID: 0038_add_prompt_persona_extension_tables
Revises: 0037_add_user_id_to_global_variables
Create Date: 2026-06-17
"""
from alembic import op
import sqlalchemy as sa


revision = '0038_add_prompt_persona_extension_tables'
down_revision = '0037_add_user_id_to_global_variables'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _table_exists("prompt_presets"):
        op.create_table(
            "prompt_presets",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("entries", sa.Text(), nullable=True),
            sa.Column("config", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )

    if not _table_exists("personas"):
        op.create_table(
            "personas",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("avatar", sa.String(), nullable=True),
            sa.Column("character_bindings", sa.Text(), nullable=True),
            sa.Column("is_default", sa.Boolean(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )

    if not _table_exists("extension_prompts"):
        op.create_table(
            "extension_prompts",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("session_id", sa.String(), nullable=True),
            sa.Column("identifier", sa.String(), nullable=False),
            sa.Column("content", sa.Text(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=True),
            sa.Column("depth", sa.Integer(), nullable=True),
            sa.Column("role", sa.String(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )


def downgrade() -> None:
    for table in ["prompt_presets", "personas", "extension_prompts"]:
        if _table_exists(table):
            op.drop_table(table)
