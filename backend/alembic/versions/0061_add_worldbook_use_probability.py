"""add world_book_stages.use_probability for ST 1.18.0 useProbability parity

Revision ID: 0061_add_worldbook_use_probability
Revises: 0060_add_user_setting_mvu_secondary
Create Date: 2026-08-25

New column:
- world_book_stages.use_probability (Boolean, default True, NOT NULL)
  ST 1.18.0 entry ``useProbability``: when False the entry ignores
  ``probability`` and always fires; when True it rolls probability%.
  Consumed by ``_scan_entries`` (worldbook_service.py).
"""
from alembic import op
import sqlalchemy as sa


revision = '0061_add_worldbook_use_probability'
down_revision = '0060_add_user_setting_mvu_secondary'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("world_book_stages", "use_probability"):
        op.add_column(
            "world_book_stages",
            sa.Column(
                "use_probability",
                sa.Boolean(),
                server_default=sa.text("true"),
                nullable=False,
            ),
        )


def downgrade() -> None:
    if _column_exists("world_book_stages", "use_probability"):
        op.drop_column("world_book_stages", "use_probability")
