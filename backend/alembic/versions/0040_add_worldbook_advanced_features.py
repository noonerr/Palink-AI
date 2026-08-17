"""add worldbook advanced features (min_activations, delay_until_recursion, triggers, outlet_name, budget fields)

Revision ID: 0040_add_worldbook_advanced_features
Revises: 0039_add_regex_scripts_table
Create Date: 2026-06-26

New columns:
- world_books.budget_tokens (String)   "10%" percentage of maxContext, or "1000" fixed tokens
- world_books.budget_cap (Integer)     hard upper limit on budget (0 = no cap)
- world_book_stages.min_activations (Integer)        group min activations (0 = disabled)
- world_book_stages.delay_until_recursion (Integer)  delay until recursion depth N (0 = disabled)
- world_book_stages.triggers (Text)     JSON array of trigger types (empty = all)
- world_book_stages.outlet_name (String) named outlet for position=7
"""
from alembic import op
import sqlalchemy as sa


revision = '0040_add_worldbook_advanced_features'
down_revision = '0039_add_regex_scripts_table'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    # World-book-level budget fields
    if not _column_exists("world_books", "budget_tokens"):
        op.add_column(
            "world_books",
            sa.Column("budget_tokens", sa.String(), nullable=True),
        )
    if not _column_exists("world_books", "budget_cap"):
        op.add_column(
            "world_books",
            sa.Column("budget_cap", sa.Integer(), server_default=sa.text("0"), nullable=True),
        )

    # Entry-level advanced fields
    stage_columns = [
        ("min_activations", sa.Integer(), 0),
        ("delay_until_recursion", sa.Integer(), 0),
        ("triggers", sa.Text(), None),
        ("outlet_name", sa.String(), None),
    ]
    for col_name, col_type, default in stage_columns:
        if not _column_exists("world_book_stages", col_name):
            kwargs = {"nullable": True}
            if default is not None:
                kwargs["server_default"] = sa.text(str(default))
            op.add_column(
                "world_book_stages",
                sa.Column(col_name, col_type, **kwargs),
            )


def downgrade() -> None:
    for col_name in ("outlet_name", "triggers", "delay_until_recursion", "min_activations"):
        if _column_exists("world_book_stages", col_name):
            op.drop_column("world_book_stages", col_name)
    for col_name in ("budget_cap", "budget_tokens"):
        if _column_exists("world_books", col_name):
            op.drop_column("world_books", col_name)
