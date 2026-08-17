"""add preset_data to characters table

Revision ID: 0020_add_preset_data
Revises: 0019_add_casdoor_id
Create Date: 2026-05-20
"""
from alembic import op
import sqlalchemy as sa


revision = '0020_add_preset_data'
down_revision = '0019_add_casdoor_id'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def upgrade():
    if not _column_exists("characters", "preset_data"):
        op.add_column(
            "characters",
            sa.Column("preset_data", sa.Text, nullable=True),
        )


def downgrade():
    if _column_exists("characters", "preset_data"):
        op.drop_column('characters', 'preset_data')
