"""add oauth tables and remove casdoor_id

Revision ID: 0024_add_oauth_tables
Revises: 0023_add_auto_generate_chat_images
Create Date: 2026-06-04
"""
from alembic import op
import sqlalchemy as sa


revision = '0024_add_oauth_tables'
down_revision = '0023_add_auto_generate_chat_images'
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


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return table_name in insp.get_table_names()


def upgrade() -> None:
    if not _table_exists("oauth_accounts"):
        op.create_table(
            "oauth_accounts",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("provider", sa.String(50), nullable=False),
            sa.Column("provider_user_id", sa.String(255), nullable=False),
            sa.Column("provider_username", sa.String(255), nullable=True),
            sa.Column("provider_avatar", sa.String(), nullable=True),
            sa.Column("access_token", sa.Text(), nullable=True),
            sa.Column("refresh_token", sa.Text(), nullable=True),
            sa.Column("token_expires_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("provider", "provider_user_id", name="uq_oauth_provider_user"),
        )
        op.create_index("ix_oauth_accounts_id", "oauth_accounts", ["id"])
        op.create_index(op.f("ix_oauth_accounts_user_id"), "oauth_accounts", ["user_id"])

    if _index_exists("users", "ix_users_casdoor_id"):
        op.drop_index("ix_users_casdoor_id", table_name="users")
    if _column_exists("users", "casdoor_id"):
        op.drop_column("users", "casdoor_id")


def downgrade() -> None:
    if _table_exists("oauth_accounts"):
        op.drop_table("oauth_accounts")

    if not _column_exists("users", "casdoor_id"):
        op.add_column(
            "users",
            sa.Column("casdoor_id", sa.String(255), nullable=True),
        )
    if not _index_exists("users", "ix_users_casdoor_id"):
        op.create_index(
            "ix_users_casdoor_id",
            "users",
            ["casdoor_id"],
            unique=True,
        )
