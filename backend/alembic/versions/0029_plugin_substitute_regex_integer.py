"""store regex substitute mode as integer

Revision ID: 0029_plugin_substitute_regex_integer
Revises: 0028_add_sillytavern_message_fields
Create Date: 2026-06-08

"""
from alembic import op
import sqlalchemy as sa


revision = '0029_plugin_substitute_regex_integer'
down_revision = '0028_add_sillytavern_message_fields'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    return table_name in sa.inspect(bind).get_table_names()


def _column_type_name(table_name: str, column_name: str) -> str:
    bind = op.get_bind()
    for column in sa.inspect(bind).get_columns(table_name):
        if column["name"] == column_name:
            return column["type"].__class__.__name__.lower()
    return ""


def upgrade():
    table_name = "plugin_scripts"
    if not _table_exists(table_name):
        return
    type_name = _column_type_name(table_name, "substitute_regex")
    if not type_name or "int" in type_name:
        return

    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "postgresql":
        op.execute("""
            ALTER TABLE plugin_scripts
            ALTER COLUMN substitute_regex DROP DEFAULT,
            ALTER COLUMN substitute_regex TYPE INTEGER
            USING CASE
                WHEN substitute_regex IS TRUE THEN 1
                WHEN substitute_regex IS FALSE THEN 0
                ELSE 0
            END,
            ALTER COLUMN substitute_regex SET DEFAULT 0
        """)
        return

    with op.batch_alter_table(table_name) as batch_op:
        batch_op.alter_column(
            "substitute_regex",
            existing_type=sa.Boolean(),
            type_=sa.Integer(),
            existing_nullable=True,
            server_default="0",
        )


def downgrade():
    table_name = "plugin_scripts"
    if not _table_exists(table_name):
        return
    type_name = _column_type_name(table_name, "substitute_regex")
    if "bool" in type_name:
        return

    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "postgresql":
        op.execute("""
            ALTER TABLE plugin_scripts
            ALTER COLUMN substitute_regex DROP DEFAULT,
            ALTER COLUMN substitute_regex TYPE BOOLEAN
            USING substitute_regex <> 0,
            ALTER COLUMN substitute_regex SET DEFAULT true
        """)
        return

    with op.batch_alter_table(table_name) as batch_op:
        batch_op.alter_column(
            "substitute_regex",
            existing_type=sa.Integer(),
            type_=sa.Boolean(),
            existing_nullable=True,
            server_default="true",
        )
