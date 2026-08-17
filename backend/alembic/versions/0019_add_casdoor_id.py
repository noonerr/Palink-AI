"""add casdoor_id to users table

Revision ID: 0019_add_casdoor_id
Revises: 0018_add_performance_indexes
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa


revision = '0019_add_casdoor_id'
down_revision = '0018_add_performance_indexes'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns(table_name)]
    return column_name in cols


def _index_exists(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    indexes = insp.get_indexes(table_name)
    return any(idx["name"] == index_name for idx in indexes)


def upgrade():
    if not _column_exists("users", "casdoor_id"):
        op.add_column(
            "users",
            sa.Column("casdoor_id", sa.String(255), nullable=True),
        )
    if not _index_exists("users", "ix_users_casdoor_id"):
        op.create_index(
            'ix_users_casdoor_id',
            'users',
            ['casdoor_id'],
            unique=True,
        )


def downgrade():
    if _index_exists("users", "ix_users_casdoor_id"):
        op.drop_index('ix_users_casdoor_id', table_name='users')
    if _column_exists("users", "casdoor_id"):
        op.drop_column('users', 'casdoor_id')
