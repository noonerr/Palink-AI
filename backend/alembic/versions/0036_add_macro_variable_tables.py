"""add macro variable tables

Revision ID: 0036_add_macro_variable_tables
Revises: 0035_add_st_grade_worldbook_fields_and_entry_state
Create Date: 2026-06-15
"""
from alembic import op
import sqlalchemy as sa


revision = '0036_add_macro_variable_tables'
down_revision = '0035_add_st_grade_worldbook_fields_and_entry_state'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _table_exists("chat_variables"):
        op.create_table(
            "chat_variables",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("session_id", sa.String(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("value", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("session_id", "key", name="uq_chat_variable"),
        )

    if not _table_exists("user_variables"):
        op.create_table(
            "user_variables",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("value", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("user_id", "key", name="uq_user_variable"),
        )

    if not _table_exists("global_variables"):
        op.create_table(
            "global_variables",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("value", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("key", name="uq_global_variable_key"),
        )


def downgrade() -> None:
    for table in ["chat_variables", "user_variables", "global_variables"]:
        if _table_exists(table):
            op.drop_table(table)
