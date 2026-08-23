"""add user_settings mvu_secondary columns

Revision ID: 0060_add_user_setting_mvu_secondary
Revises: 0059_add_e10_assembly_indexes
Create Date: 2026-08-19

Adds MVU 副 AI 变量更新配置列到 user_settings：
  - mvu_secondary_model   (String, nullable)  副模型 ID，空 = 不启用
  - mvu_secondary_enabled (Boolean, default False)  副 AI 开关

Idempotent: uses ADD COLUMN IF NOT EXISTS pattern via inspection.
"""
from alembic import op
import sqlalchemy as sa


revision = '0060_add_user_setting_mvu_secondary'
down_revision = '0059_add_e10_assembly_indexes'
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    return table_name in sa.inspect(bind).get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    if table_name not in sa.inspect(bind).get_table_names():
        return False
    return any(c["name"] == column_name for c in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    """Add user_settings.mvu_secondary_model / mvu_secondary_enabled columns."""
    if not _table_exists("user_settings"):
        return
    bind = op.get_bind()
    dialect = bind.dialect.name

    if not _column_exists("user_settings", "mvu_secondary_model"):
        if dialect == "sqlite":
            bind.execute(sa.text(
                "ALTER TABLE user_settings ADD COLUMN mvu_secondary_model VARCHAR"
            ))
        else:
            bind.execute(sa.text(
                "ALTER TABLE user_settings ADD COLUMN mvu_secondary_model VARCHAR"
            ))

    if not _column_exists("user_settings", "mvu_secondary_enabled"):
        if dialect == "sqlite":
            bind.execute(sa.text(
                "ALTER TABLE user_settings ADD COLUMN mvu_secondary_enabled BOOLEAN NOT NULL DEFAULT 0"
            ))
        else:
            bind.execute(sa.text(
                "ALTER TABLE user_settings ADD COLUMN mvu_secondary_enabled BOOLEAN NOT NULL DEFAULT FALSE"
            ))


def downgrade() -> None:
    """Drop user_settings.mvu_secondary columns."""
    if not _table_exists("user_settings"):
        return
    bind = op.get_bind()
    dialect = bind.dialect.name

    if _column_exists("user_settings", "mvu_secondary_model"):
        try:
            bind.execute(sa.text("ALTER TABLE user_settings DROP COLUMN mvu_secondary_model"))
        except Exception:
            pass
    if _column_exists("user_settings", "mvu_secondary_enabled"):
        try:
            bind.execute(sa.text("ALTER TABLE user_settings DROP COLUMN mvu_secondary_enabled"))
        except Exception:
            pass
