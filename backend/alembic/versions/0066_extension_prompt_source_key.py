"""extension_prompts.source_key：卡脚本上报快照的内容来源键（PROMPT-EVERY-TURN 2026-10-02）

Revision ID: 0066_extension_prompt_source_key
Revises: 0065_drop_dialogue_mode_column
Create Date: 2026-10-02

背景：卡插件经 setExtensionPrompt 注册的「对话渲染格式规范」随 iframe 生命周期
起伏（开场卡卸载后规范缺席，AI 回复失去排版框）。主方案（用户拍板）：前端在
卡脚本上报 extension_prompts 时同步落库到 extension_prompts 表（现 0 行），
装配层每轮无条件带上；前端实时上报通道保留、按 identifier 高优覆盖。

本次仅新增一个可空列 source_key（String）：
- NULL   = 手动/历史行，读取侧行为零变化；
- 非 NULL = 前端上报快照，键为插件脚本包内容的稳定哈希。重导入换 char id
  不失效（同内容同键）、同名不同卡不串（不同内容不同键）；
  归属卡由 filter.character_ids 维护（persist 端点负责挂/摘）。

安全属性：纯新增可空列，无数据改写。与 ORM 同 commit；
core/migrations.py 的 _RUNTIME_COMPAT_COLUMNS 同步登记（仅本列，勿回填他列）。
"""
from alembic import op
import sqlalchemy as sa


revision = '0066_extension_prompt_source_key'
down_revision = '0065_drop_dialogue_mode_column'
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return False
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("extension_prompts", "source_key"):
        op.add_column("extension_prompts", sa.Column("source_key", sa.String(), nullable=True))


def downgrade() -> None:
    if _column_exists("extension_prompts", "source_key"):
        op.drop_column("extension_prompts", "source_key")
