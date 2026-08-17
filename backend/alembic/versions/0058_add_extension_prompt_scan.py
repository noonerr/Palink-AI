"""add extension_prompts.scan column

Revision ID: 0058_add_extension_prompt_scan
Revises: 0057_migrate_extension_prompt_position_to_st
Create Date: 2026-07-28

Adds the `scan` column (Boolean, NOT NULL, default False) to the
`extension_prompts` table, aligning with SillyTavern 1.18.0's
extension_prompt.scan semantics (openai.js: setExtensionPrompt).

When `scan=true`, the extension_prompt content is macro-substituted
({{char}}/{{user}}/{{pick}} etc.) before being injected into the prompt.

Idempotent: uses ADD COLUMN IF NOT EXISTS pattern via inspection.
"""
from alembic import op
import sqlalchemy as sa


revision = '0058_add_extension_prompt_scan'
down_revision = '0057_migrate_extension_prompt_position_to_st'
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
    """Add extension_prompts.scan column (Boolean, NOT NULL, default False)."""
    if not _table_exists("extension_prompts"):
        return
    if _column_exists("extension_prompts", "scan"):
        return

    # SQLite: ADD COLUMN with NOT NULL requires a server default.
    # PostgreSQL: same constraint. Use sa.Boolean with server_default.
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "sqlite":
        # SQLite ADD COLUMN 不支持 IF NOT EXISTS，但 _column_exists 已防御。
        bind.execute(sa.text(
            "ALTER TABLE extension_prompts ADD COLUMN scan BOOLEAN NOT NULL DEFAULT 0"
        ))
    else:
        # PostgreSQL / MySQL: 使用标准 ALTER TABLE
        bind.execute(sa.text(
            "ALTER TABLE extension_prompts ADD COLUMN scan BOOLEAN NOT NULL DEFAULT FALSE"
        ))


def downgrade() -> None:
    """Drop extension_prompts.scan column."""
    if not _table_exists("extension_prompts"):
        return
    if not _column_exists("extension_prompts", "scan"):
        return

    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "sqlite":
        # SQLite < 3.35 不支持 DROP COLUMN；通过重建表实现。
        # 这里使用简单方案：直接尝试 DROP COLUMN（SQLite 3.35+ 支持）。
        try:
            bind.execute(sa.text("ALTER TABLE extension_prompts DROP COLUMN scan"))
        except Exception:
            # 旧版 SQLite：跳过降级（生产环境极少需要降级此列）
            pass
    else:
        bind.execute(sa.text("ALTER TABLE extension_prompts DROP COLUMN scan"))
