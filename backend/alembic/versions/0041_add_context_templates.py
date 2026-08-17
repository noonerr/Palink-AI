"""add context_templates table and generation_presets.context_template_name

Revision ID: 0041_add_context_templates
Revises: 0040_add_worldbook_advanced_features
Create Date: 2026-06-26

New table:
- context_templates: ST 1.18.0 context template definitions
  (story_string, chat_start, system_prompt, jailbreak, normal_prompt,
  group_prompt, is_builtin)

New column:
- generation_presets.context_template_name (String, nullable)
  Name of the ContextTemplate to apply when assembling messages for this
  preset. NULL/empty falls back to the "Default" template.
"""
from alembic import op
import sqlalchemy as sa


revision = '0041_add_context_templates'
down_revision = '0040_add_worldbook_advanced_features'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _table_exists("context_templates"):
        op.create_table(
            "context_templates",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("display_name", sa.String(), nullable=True),
            sa.Column("story_string", sa.Text(), nullable=True),
            sa.Column("chat_start", sa.String(), nullable=True),
            sa.Column("system_prompt", sa.String(), nullable=True),
            sa.Column("jailbreak", sa.String(), nullable=True),
            sa.Column("normal_prompt", sa.String(), nullable=True),
            sa.Column("group_prompt", sa.String(), nullable=True),
            sa.Column(
                "is_builtin",
                sa.Boolean(),
                server_default=sa.text("true"),
                nullable=False,
            ),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_context_templates_name",
            "context_templates",
            ["name"],
            unique=True,
        )

    if not _column_exists("generation_presets", "context_template_name"):
        op.add_column(
            "generation_presets",
            sa.Column("context_template_name", sa.String(), nullable=True),
        )


def downgrade() -> None:
    if _column_exists("generation_presets", "context_template_name"):
        op.drop_column("generation_presets", "context_template_name")
    if _table_exists("context_templates"):
        op.drop_index("ix_context_templates_name", table_name="context_templates")
        op.drop_table("context_templates")
