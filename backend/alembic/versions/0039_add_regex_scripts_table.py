"""add regex_scripts table

Revision ID: 0039_add_regex_scripts_table
Revises: 0038_add_prompt_persona_extension_tables
Create Date: 2026-06-17
"""
from alembic import op
import sqlalchemy as sa


revision = '0039_add_regex_scripts_table'
down_revision = '0038_add_prompt_persona_extension_tables'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if _table_exists("regex_scripts"):
        return

    op.create_table(
        "regex_scripts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("find_regex", sa.Text(), nullable=False),
        sa.Column("replace_string", sa.Text(), nullable=False),
        sa.Column("trim_strings", sa.Text(), nullable=True),
        sa.Column("placement", sa.Text(), nullable=True),
        sa.Column("disabled", sa.Boolean(), nullable=True),
        sa.Column("markdown_only", sa.Boolean(), nullable=True),
        sa.Column("prompt_only", sa.Boolean(), nullable=True),
        sa.Column("run_on_edit", sa.Boolean(), nullable=True),
        sa.Column("substitute_regex", sa.Integer(), nullable=True),
        sa.Column("min_depth", sa.Integer(), nullable=True),
        sa.Column("max_depth", sa.Integer(), nullable=True),
        sa.Column("order", sa.Integer(), nullable=True),
        sa.Column("is_scope", sa.Boolean(), nullable=True),
        sa.Column("scope_id", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index(
        "ix_regex_scripts_user_id",
        "regex_scripts",
        ["user_id"],
    )
    op.create_index(
        "ix_regex_scripts_scope_id",
        "regex_scripts",
        ["scope_id"],
    )


def downgrade() -> None:
    if not _table_exists("regex_scripts"):
        return
    op.drop_index("ix_regex_scripts_scope_id", table_name="regex_scripts")
    op.drop_index("ix_regex_scripts_user_id", table_name="regex_scripts")
    op.drop_table("regex_scripts")
