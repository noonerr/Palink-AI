"""add user_id to global_variables

Revision ID: 0037_add_user_id_to_global_variables
Revises: 0036_add_macro_variable_tables
Create Date: 2026-06-15
"""
from alembic import op
import sqlalchemy as sa


revision = '0037_add_user_id_to_global_variables'
down_revision = '0036_add_macro_variable_tables'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _constraint_exists(table_name: str, constraint_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for c in inspector.get_unique_constraints(table_name):
        if c["name"] == constraint_name:
            return True
    return False


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return column_name in [c["name"] for c in inspector.get_columns(table_name)]


def upgrade() -> None:
    if not _table_exists("global_variables"):
        return

    # 1. Add user_id column if not exists
    if not _column_exists("global_variables", "user_id"):
        op.add_column(
            "global_variables",
            sa.Column("user_id", sa.Integer(), nullable=True),
        )

    # 2. Set default user_id for existing rows
    op.execute("UPDATE global_variables SET user_id = 0 WHERE user_id IS NULL")

    # 3. Make user_id non-nullable
    op.alter_column("global_variables", "user_id", existing_type=sa.Integer(), nullable=False)

    # 4. Drop old unique constraint on key only
    if _constraint_exists("global_variables", "uq_global_variable_key"):
        op.drop_constraint("uq_global_variable_key", "global_variables", type_="unique")

    # 5. Add new unique constraint on (user_id, key)
    if not _constraint_exists("global_variables", "uq_global_variable"):
        op.create_unique_constraint("uq_global_variable", "global_variables", ["user_id", "key"])


def downgrade() -> None:
    if not _table_exists("global_variables"):
        return

    if _constraint_exists("global_variables", "uq_global_variable"):
        op.drop_constraint("uq_global_variable", "global_variables", type_="unique")

    if _column_exists("global_variables", "user_id"):
        op.drop_column("global_variables", "user_id")

    if not _constraint_exists("global_variables", "uq_global_variable_key"):
        op.create_unique_constraint("uq_global_variable_key", "global_variables", ["key"])
