"""A1 收尾：drop user_settings.silly_tavern_mode / silly_tavern_theme

Revision ID: 0062_drop_st_mode_theme_columns
Revises: 0061_add_worldbook_use_probability
Create Date: 2026-09-04

ST 双轨（st-compat / st-native）已于 2026-09-03 删除（commit 091023e /
aeb8348 / 4eadb86 / 6c47535）。这两列自封存（2026-08-24 MODE-SEALED）起
即为死摆设：mode 恒 "palink-native"、theme 无消费方。前端已于阶段2
摘除全部读写，本迁移收尾清除 DB 列。

⚠️ 同步约束：core/migrations.py 的 _RUNTIME_COMPAT_COLUMNS 补列清单
不得回填这两列，否则后端重启会把列重建回来（T1 陷阱）。
"""
from alembic import op
import sqlalchemy as sa


revision = '0062_drop_st_mode_theme_columns'
down_revision = '0061_add_worldbook_use_probability'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    # 列内仅存封存期的死值（mode 恒 "palink-native"），丢弃无信息损失。
    if _column_exists("user_settings", "silly_tavern_mode"):
        op.drop_column("user_settings", "silly_tavern_mode")
    if _column_exists("user_settings", "silly_tavern_theme"):
        op.drop_column("user_settings", "silly_tavern_theme")


def downgrade() -> None:
    if not _column_exists("user_settings", "silly_tavern_mode"):
        op.add_column(
            "user_settings",
            sa.Column("silly_tavern_mode", sa.String(), server_default="palink-native"),
        )
    if not _column_exists("user_settings", "silly_tavern_theme"):
        op.add_column(
            "user_settings",
            sa.Column("silly_tavern_theme", sa.String(), server_default="palink"),
        )
