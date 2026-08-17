"""add sillytavern message compatibility fields

Revision ID: 0028_add_sillytavern_message_fields
Revises: 0027_add_plugins
Create Date: 2026-06-08

"""
from alembic import op
import sqlalchemy as sa


revision = '0028_add_sillytavern_message_fields'
down_revision = '0027_add_plugins'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade():
    table_name = "character_chat_messages"
    if not _column_exists(table_name, "name"):
        op.add_column(table_name, sa.Column("name", sa.String(), nullable=True))
    if not _column_exists(table_name, "is_user"):
        op.add_column(table_name, sa.Column("is_user", sa.Boolean(), nullable=True))
    if not _column_exists(table_name, "is_system"):
        op.add_column(table_name, sa.Column("is_system", sa.Boolean(), nullable=True))
    if not _column_exists(table_name, "mesid"):
        op.add_column(table_name, sa.Column("mesid", sa.Integer(), nullable=True))
    if not _column_exists(table_name, "swipe_id"):
        op.add_column(table_name, sa.Column("swipe_id", sa.Integer(), nullable=True, server_default="0"))
    if not _column_exists(table_name, "swipes"):
        op.add_column(table_name, sa.Column("swipes", sa.Text(), nullable=True))
    if not _column_exists(table_name, "extra"):
        op.add_column(table_name, sa.Column("extra", sa.Text(), nullable=True))


def downgrade():
    table_name = "character_chat_messages"
    for column_name in ("extra", "swipes", "swipe_id", "mesid", "is_system", "is_user", "name"):
        if _column_exists(table_name, column_name):
            op.drop_column(table_name, column_name)
