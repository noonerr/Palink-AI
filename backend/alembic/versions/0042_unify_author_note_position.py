"""unify author_note_position into a single Integer column

Revision ID: 0042_unify_author_note_position
Revises: 0041_add_context_templates
Create Date: 2026-06-28

Consolidates the redundant dual-field author_note_position schema on
user_settings:
- author_note_position (String: "before_char"/"after_char") — legacy
- author_note_position_int (Integer: 0/1/2/3) — ST 1.18.0 int position

ST 1.18.0 expects a single Integer field. This migration:
- Converts the String column values to Integer
  ("before_char" -> 0, "after_char"/other/null -> 1)
- ALTERs the column type String -> Integer
- DROPs the redundant author_note_position_int column

Downgrade reverses the conversion, restoring the dual-field layout.
"""
from alembic import op
import sqlalchemy as sa


revision = '0042_unify_author_note_position'
down_revision = '0041_add_context_templates'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    return table_name in sa.inspect(bind).get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    if table_name not in sa.inspect(bind).get_table_names():
        return False
    return any(column["name"] == column_name for column in sa.inspect(bind).get_columns(table_name))


def _column_type_name(table_name: str, column_name: str) -> str:
    bind = op.get_bind()
    for column in sa.inspect(bind).get_columns(table_name):
        if column["name"] == column_name:
            return column["type"].__class__.__name__.lower()
    return ""


def upgrade() -> None:
    table_name = "user_settings"
    if not _table_exists(table_name):
        return

    bind = op.get_bind()
    dialect = bind.dialect.name

    if _column_exists(table_name, "author_note_position"):
        type_name = _column_type_name(table_name, "author_note_position")
        # Only convert when the column is still a String variant (idempotent:
        # skip if already Integer, e.g. fresh DB created from the new model).
        if type_name and "int" not in type_name:
            # Step 1: normalize String values to numeric strings so the
            # subsequent type cast preserves data:
            #   "before_char" -> 0 (in story / depth)
            #   "after_char"  -> 1 (after post-history)
            #   other / NULL  -> 1 (default)
            op.execute(
                "UPDATE user_settings "
                "SET author_note_position = CASE "
                "WHEN author_note_position = 'before_char' THEN '0' "
                "ELSE '1' END"
            )

            # Step 2: ALTER column type String -> Integer.
            if dialect == "postgresql":
                op.execute(
                    "ALTER TABLE user_settings "
                    "ALTER COLUMN author_note_position TYPE INTEGER "
                    "USING author_note_position::integer"
                )
            else:
                with op.batch_alter_table(table_name) as batch_op:
                    batch_op.alter_column(
                        "author_note_position",
                        existing_type=sa.String(),
                        type_=sa.Integer(),
                        existing_nullable=True,
                    )

    # Step 3: DROP the redundant author_note_position_int column.
    if _column_exists(table_name, "author_note_position_int"):
        op.drop_column(table_name, "author_note_position_int")


def downgrade() -> None:
    table_name = "user_settings"
    if not _table_exists(table_name):
        return

    bind = op.get_bind()
    dialect = bind.dialect.name

    # Step 1: re-add the legacy author_note_position_int column (Integer).
    if not _column_exists(table_name, "author_note_position_int"):
        op.add_column(
            table_name,
            sa.Column("author_note_position_int", sa.Integer(), nullable=True),
        )

    if not _column_exists(table_name, "author_note_position"):
        return

    # Step 2: copy the current Integer position value into _int so the
    # effective value survives the type swap below.
    op.execute(
        "UPDATE user_settings "
        "SET author_note_position_int = author_note_position"
    )

    type_name = _column_type_name(table_name, "author_note_position")
    if "int" in type_name:
        # Step 3: ALTER column type Integer -> String.
        if dialect == "postgresql":
            op.execute(
                "ALTER TABLE user_settings "
                "ALTER COLUMN author_note_position TYPE VARCHAR "
                "USING author_note_position::text"
            )
        else:
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.alter_column(
                    "author_note_position",
                    existing_type=sa.Integer(),
                    type_=sa.String(),
                    existing_nullable=True,
                )

        # Step 4: convert Integer values back to legacy strings, using the
        # preserved _int value (reliably Integer) for the comparison to
        # avoid cross-storage-class comparison pitfalls on SQLite:
        #   0 -> "before_char", 1/other -> "after_char"
        op.execute(
            "UPDATE user_settings "
            "SET author_note_position = CASE "
            "WHEN author_note_position_int = 0 THEN 'before_char' "
            "ELSE 'after_char' END"
        )
