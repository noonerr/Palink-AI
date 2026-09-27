"""删除第一/第三人称切换（身份层 ST 化 T3）：drop character_chat_sessions.dialogue_mode

Revision ID: 0065_drop_dialogue_mode_column
Revises: 0064_add_character_plugin_state
Create Date: 2026-09-27

对齐 ST 1.18.0 main 槽（单一第三人称任务指令），第一/第三人称切换整链删除
（UI / 请求体 / ORM / 宏）。实测该列全部存量仅 "first_person"（22 条）与
NULL（2 条），third_person 使用 0 次——删除无功能损失。

⚠️ 同步约束（T2 陷阱）：该列此前源自 ORM create_all（alembic/versions 零
命中），本修订与 models/character.py 的 Column 声明删除必须同 commit；
core/migrations.py 的 _RUNTIME_COMPAT_COLUMNS 禁止回填本列，否则后端
重启会把列重建回来。
"""
from alembic import op
import sqlalchemy as sa


revision = '0065_drop_dialogue_mode_column'
down_revision = '0064_add_character_plugin_state'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if _column_exists("character_chat_sessions", "dialogue_mode"):
        op.drop_column("character_chat_sessions", "dialogue_mode")


def downgrade() -> None:
    if not _column_exists("character_chat_sessions", "dialogue_mode"):
        op.add_column(
            "character_chat_sessions",
            sa.Column("dialogue_mode", sa.String(), server_default="first_person"),
        )
