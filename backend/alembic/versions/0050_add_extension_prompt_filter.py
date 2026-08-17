"""add filter column to extension_prompts

Revision ID: 0050_add_extension_prompt_filter
Revises: 0049_add_message_content_json
Create Date: 2026-07-18

New column:
- extension_prompts.filter (Text, nullable=True)
  Stores JSON-encoded filter config (e.g. {"character_ids": [...],
  "session_ids": [...]}). Used by prompt assembly to decide whether
  the prompt should be injected for the current character/session.

Position validation (0-3) is enforced at the SQLAlchemy/Python level
via @validates on the model, not via a database CHECK constraint, to
keep the migration portable across SQLite/MySQL/PostgreSQL.
"""
from alembic import op
import sqlalchemy as sa


revision = '0050_add_extension_prompt_filter'
down_revision = '0049_add_message_content_json'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    if not _table_exists("extension_prompts"):
        return
    if not _column_exists("extension_prompts", "filter"):
        op.add_column(
            "extension_prompts",
            sa.Column("filter", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    if not _table_exists("extension_prompts"):
        return
    if _column_exists("extension_prompts", "filter"):
        op.drop_column("extension_prompts", "filter")
