"""add web_search_results to messages

Revision ID: 0015_add_web_search_results
Revises: 0014_merge_branches
Create Date: 2026-05-11
"""
from alembic import op
import sqlalchemy as sa


revision = '0015_add_web_search_results'
down_revision = '0014_merge_branches'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("messages", "web_search_results"):
        op.add_column(
            "messages",
            sa.Column("web_search_results", sa.Text(), nullable=True),
        )


def downgrade():
    op.drop_column("messages", "web_search_results")
