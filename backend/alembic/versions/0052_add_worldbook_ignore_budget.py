"""add world_book_stages.ignore_budget for ST 1.18.0 ignoreBudget parity

Revision ID: 0052_add_worldbook_ignore_budget
Revises: 0051_add_instruct_template_st1180_fields
Create Date: 2026-07-18

New column:
- world_book_stages.ignore_budget (Boolean, default False)
  ST 1.18.0 ``extensions.ignore_budget``: when True, the entry is exempt
  from token budget truncation. Reference: world-info.js:4898-4907, 4942.
  Used by ``_apply_budget`` to keep ignoreBudget entries even when the
  budget would otherwise trim them.
"""
from alembic import op
import sqlalchemy as sa


revision = '0052_add_worldbook_ignore_budget'
down_revision = '0051_add_instruct_template_st1180_fields'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("world_book_stages", "ignore_budget"):
        op.add_column(
            "world_book_stages",
            sa.Column(
                "ignore_budget",
                sa.Boolean(),
                server_default=sa.text("false"),
                nullable=False,
            ),
        )


def downgrade() -> None:
    if _column_exists("world_book_stages", "ignore_budget"):
        op.drop_column("world_book_stages", "ignore_budget")
