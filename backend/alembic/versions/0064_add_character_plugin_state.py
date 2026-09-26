"""补 0064：角色卡级插件按需启用（[PLUGIN-ON-DEMAND] 2026-09-26）

Revision ID: 0064_add_character_plugin_state
Revises: 0063_add_persona_description_depth
Create Date: 2026-09-26

背景：plugins 表只有全局 enabled 开关（无 character_id 列），卡内扩展一旦导入
就对所有角色卡生效（2026-08-21 实测泄漏：裸卡被要求输出无渲染的 @bubble 标记）。
本次为"每张卡一份名单"建立存储层：

1. characters.plugin_scope_mode（String, 可空）
   - NULL / 'inherit'  = 沿用全局开关（**所有存量角色的默认状态，行为零变化**）
   - 'allowlist'       = 只有 character_plugin_state 中 enabled=True 的插件下发
2. character_plugin_state 关联表（character_id + plugin_id 唯一）。

两者分开是为了能表达「用户明确确认过一张卡什么都不装」的空白名单 ——
只靠"有没有行"无法区分"空名单"与"从未设置"。

安全属性：本次纯新增（一张新表 + 一个可空列），无数据改写。
存量行 plugin_scope_mode 为 NULL，读取侧按 'inherit' 兜底 → 不改任何现有行为。
"""
from alembic import op
import sqlalchemy as sa


revision = '0064_add_character_plugin_state'
down_revision = '0063_add_persona_description_depth'
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
    if not _column_exists("characters", "plugin_scope_mode"):
        op.add_column(
            "characters",
            sa.Column("plugin_scope_mode", sa.String(), nullable=True),
        )

    if not _table_exists("character_plugin_state"):
        op.create_table(
            "character_plugin_state",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("character_id", sa.String(), nullable=False),
            sa.Column("plugin_id", sa.String(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("source", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("character_id", "plugin_id", name="uq_character_plugin"),
        )
        op.create_index(
            "ix_character_plugin_state_character_id",
            "character_plugin_state",
            ["character_id"],
        )


def downgrade() -> None:
    if _table_exists("character_plugin_state"):
        op.drop_index("ix_character_plugin_state_character_id", table_name="character_plugin_state")
        op.drop_table("character_plugin_state")
    if _column_exists("characters", "plugin_scope_mode"):
        op.drop_column("characters", "plugin_scope_mode")
