"""add user_settings mvu_secondary params (temperature / max_tokens / retries)

Revision ID: 0068_add_mvu_secondary_params
Revises: 0067_add_memory_character_id
Create Date: 2026-10-05

[MVU-SECONDARY-PARAMS 2026-10-05] 为副 AI 变量解析放开三个可调参数。
此前它们在 app/services/mvu_secondary.py 里写死：
  temperature=0.2 / max_tokens=2048 / 无重试。

新增列（全部 nullable，NULL = 用代码内默认，**存量行为零变化**）：
  - mvu_secondary_temperature (FLOAT,   nullable)  0.0 - 2.0
  - mvu_secondary_max_tokens  (INTEGER, nullable)  256 - 8192
  - mvu_secondary_retries     (INTEGER, nullable)  0 - 3（「额外」重试次数）

为什么是正式 alembic 而不是 core/migrations.py 的 _RUNTIME_COMPAT_COLUMNS：
`mvu_secondary_*` 族一直走正式迁移（见 0060），运行时补列清单只认它自己那几列。
若只往清单里加而不写迁移，全新库不会有这些列。

Idempotent: 先 inspection 判列是否存在，再 ADD COLUMN。
"""
from alembic import op
import sqlalchemy as sa


revision = '0068_add_mvu_secondary_params'
down_revision = '0067_add_memory_character_id'
branch_labels = None
depends_on = None


_NEW_COLUMNS = (
    ("mvu_secondary_temperature", "FLOAT"),
    ("mvu_secondary_max_tokens", "INTEGER"),
    ("mvu_secondary_retries", "INTEGER"),
)


def _table_exists(table_name: str) -> bool:
    bind = op.get_bind()
    return table_name in sa.inspect(bind).get_table_names()


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    if table_name not in sa.inspect(bind).get_table_names():
        return False
    return any(c["name"] == column_name for c in sa.inspect(bind).get_columns(table_name))


def upgrade() -> None:
    """Add user_settings.mvu_secondary_{temperature,max_tokens,retries} columns."""
    if not _table_exists("user_settings"):
        return
    bind = op.get_bind()

    for column_name, column_type in _NEW_COLUMNS:
        if _column_exists("user_settings", column_name):
            continue
        # 全部 nullable 且无默认值 —— 存量行保持 NULL，读取侧回落代码内默认。
        bind.execute(sa.text(
            f"ALTER TABLE user_settings ADD COLUMN {column_name} {column_type}"
        ))


def downgrade() -> None:
    """Drop the three mvu_secondary param columns."""
    if not _table_exists("user_settings"):
        return
    bind = op.get_bind()

    for column_name, _column_type in _NEW_COLUMNS:
        if not _column_exists("user_settings", column_name):
            continue
        try:
            bind.execute(sa.text(f"ALTER TABLE user_settings DROP COLUMN {column_name}"))
        except Exception:
            pass
